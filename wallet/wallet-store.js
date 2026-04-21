// IndexedDB persistence layer for the wallet.
//
// Schema v1 — two stores. See PLANO-FASE-1-WALLET.md Sub-fase 2 for the
// rationale behind folding biometric + descriptor into `credentials`
// (revogação seletiva via nullable campos, descriptor derivável da seed).
//
//   credentials (key: "main") — single-row record:
//     id: "main"
//     version: 1                 (schema version)
//     encryptedSeed: ArrayBuffer (AES-GCM ciphertext of the 12-word mnemonic)
//     salt: ArrayBuffer          (Argon2id salt, 16 bytes, per-wallet random)
//     iv: ArrayBuffer            (AES-GCM IV, 12 bytes, per-wallet random)
//     descriptor: string | null  (plaintext CT descriptor — enables view-only
//                                 without unlock, and comparison on restore)
//     failedPinAttempts: number
//     credentialId: ArrayBuffer | null  (WebAuthn, non-resident)
//     prfSalt: ArrayBuffer | null       (WebAuthn PRF input)
//     wrappedSeedKey: ArrayBuffer | null (seed encrypted under PRF-derived key)
//     createdAt: number (epoch ms)
//
//   sync (key: "main") — optional blob from LWK for incremental scans:
//     id: "main"
//     updateBlob: ArrayBuffer | null
//     lastScanAt: number | null
//
// Wipe-on-5-wrong-PIN zeroes encryptedSeed/salt/iv/credentialId/prfSalt/
// wrappedSeedKey/failedPinAttempts but preserves `descriptor` — view-only
// survives a wipe and can be compared against a restore attempt to catch
// "wrong mnemonic" user mistakes.

import { WalletError, ERROR_CODES } from "./wallet-errors.js";

const DB_NAME = "depix-wallet";
const DB_VERSION = 1;
const CREDENTIALS_STORE = "credentials";
const SYNC_STORE = "sync";
const MAIN_KEY = "main";

export const SCHEMA_VERSION = 1;

function hasIndexedDB() {
  return typeof indexedDB !== "undefined";
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IDB transaction aborted"));
  });
}

export async function openDb(indexedDbImpl) {
  const idb = indexedDbImpl ?? (hasIndexedDB() ? indexedDB : null);
  if (!idb) {
    throw new WalletError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "IndexedDB is not available in this environment"
    );
  }
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = req.result;
      // Initial schema. Future versions add more branches here.
      if (event.oldVersion < 1) {
        db.createObjectStore(CREDENTIALS_STORE, { keyPath: "id" });
        db.createObjectStore(SYNC_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(
      new WalletError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        "Failed to open IndexedDB",
        req.error
      )
    );
    req.onblocked = () => reject(
      new WalletError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        "IndexedDB open blocked by another tab"
      )
    );
  });
}

async function withStore(db, storeName, mode, fn) {
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await fn(store);
  await promisifyTransaction(tx);
  return result;
}

export async function readCredentials(db) {
  return withStore(db, CREDENTIALS_STORE, "readonly", async store =>
    (await promisifyRequest(store.get(MAIN_KEY))) ?? null
  );
}

export async function writeCredentials(db, record) {
  const full = { ...record, id: MAIN_KEY, version: SCHEMA_VERSION };
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    await promisifyRequest(store.put(full));
    return full;
  });
}

export async function patchCredentials(db, patch) {
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    const existing = await promisifyRequest(store.get(MAIN_KEY));
    if (!existing) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No credentials to patch"
      );
    }
    const next = { ...existing, ...patch, id: MAIN_KEY };
    await promisifyRequest(store.put(next));
    return next;
  });
}

export async function deleteCredentials(db) {
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    await promisifyRequest(store.delete(MAIN_KEY));
  });
}

export async function readSync(db) {
  return withStore(db, SYNC_STORE, "readonly", async store =>
    (await promisifyRequest(store.get(MAIN_KEY))) ?? null
  );
}

export async function writeSync(db, record) {
  const full = { ...record, id: MAIN_KEY };
  return withStore(db, SYNC_STORE, "readwrite", async store => {
    await promisifyRequest(store.put(full));
    return full;
  });
}

export async function deleteSync(db) {
  return withStore(db, SYNC_STORE, "readwrite", async store => {
    await promisifyRequest(store.delete(MAIN_KEY));
  });
}

export async function hasCredentials(db) {
  const record = await readCredentials(db);
  return record !== null && record.encryptedSeed != null;
}

// Partial wipe — plan Sub-fase 2 "Wipe seletivo". Zeroes the sensitive fields
// but retains `descriptor` so:
//   1. view-only (balances, address, QR, history) keeps working, and
//   2. a later restore can compare the reconstructed descriptor against this
//      one to detect the "wrong mnemonic" case and alert the user.
export async function wipeSensitiveCredentials(db) {
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    const existing = await promisifyRequest(store.get(MAIN_KEY));
    if (!existing) return null;
    const wiped = {
      id: MAIN_KEY,
      version: SCHEMA_VERSION,
      encryptedSeed: null,
      salt: null,
      iv: null,
      credentialId: null,
      prfSalt: null,
      wrappedSeedKey: null,
      failedPinAttempts: 0,
      descriptor: existing.descriptor ?? null,
      createdAt: existing.createdAt ?? null
    };
    await promisifyRequest(store.put(wiped));
    return wiped;
  });
}

export async function resetFailedPinAttempts(db) {
  const existing = await readCredentials(db);
  if (!existing) return;
  if ((existing.failedPinAttempts ?? 0) === 0) return;
  await patchCredentials(db, { failedPinAttempts: 0 });
}

export async function incrementFailedPinAttempts(db) {
  const existing = await readCredentials(db);
  if (!existing) {
    throw new WalletError(
      ERROR_CODES.WALLET_NOT_FOUND,
      "Cannot increment counter for missing wallet"
    );
  }
  const next = (existing.failedPinAttempts ?? 0) + 1;
  await patchCredentials(db, { failedPinAttempts: next });
  return next;
}

// Full teardown used by `wipeWallet(pin)` — removes the DB entirely after PIN
// confirmation. Distinct from the per-attempt wipe above.
export async function destroyDatabase(indexedDbImpl) {
  const idb = indexedDbImpl ?? (hasIndexedDB() ? indexedDB : null);
  if (!idb) return;
  return new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase blocked"));
  });
}
