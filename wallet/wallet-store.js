// IndexedDB persistence layer for the wallet.
//
// Schema v2 — three stores. v1 had a single `sync` store with a fixed key
// "main" that held the *latest* LWK Update blob, sobrescrita a cada scan.
// That broke between-session restoration because LWK's Update is a delta,
// not a snapshot (lwk_wollet/src/update.rs:54): applying a delta to a
// freshly-built empty Wollet only works when the Wollet's status hash
// equals the delta's source status. Saving only the latest delta meant
// that on every cold start the cached blob's source hash didn't match the
// empty Wollet (which has its own deterministic empty-status hash), so
// applyUpdate threw and the catch-everything in ensureViewWollet swallowed
// the error — the cache effectively never restored.
//
// v2 adopts the pattern from liquidwebwallet.org (RCasatta/liquid-web-
// wallet, the reference LWK browser app, written by the LWK maintainer):
// persist every Update keyed by the Wollet's status BEFORE the apply, and
// at cold start replay them in a while-loop — recompute status, look up
// the next link, apply, repeat. Each session appends to the chain; a
// fresh cold start can reconstruct any reachable state.
//
//   credentials (key: "main") — single-row record:
//     id: "main"
//     version: 2                 (schema version)
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
//   wallet-updates-v1 (keyPath: "id") — chained LWK Update blobs:
//     id: string                 (decimal repr of `wollet.status()` BEFORE apply)
//     updateBlob: Uint8Array     (Update.serialize() bytes; pruned with
//                                 update.prune(wollet) to drop unneeded
//                                 witnesses before persisting)
//     savedAt: number            (epoch ms — debug only)
//
//   wallet-meta (key: "main") — sync metadata:
//     id: "main"
//     lastScanAt: number | null
//     lastSuccessAt: number | null
//     quotaExceeded: boolean
//
// Migration v1→v2 is destructive: the old `sync` store is dropped because
// the blob it held was a stale orphaned delta useless without its full
// chain. Users restart their cache on first boot post-upgrade; the next
// successful scan repopulates wallet-updates-v1 from genesis.
//
// Wipe-on-5-wrong-PIN zeroes encryptedSeed/salt/iv/credentialId/prfSalt/
// wrappedSeedKey/failedPinAttempts but preserves `descriptor` — view-only
// survives a wipe and can be compared against a restore attempt to catch
// "wrong mnemonic" user mistakes.

import { WalletError, ERROR_CODES } from "./wallet-errors.js";

const DB_NAME = "depix-wallet";
const DB_VERSION = 2;
const CREDENTIALS_STORE = "credentials";
const UPDATES_STORE = "wallet-updates-v1";
const META_STORE = "wallet-meta";
const MAIN_KEY = "main";

// Public for tests + external migration probes.
export const SCHEMA_VERSION = 2;

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
      // v0 → v1: initial create.
      if (event.oldVersion < 1) {
        db.createObjectStore(CREDENTIALS_STORE, { keyPath: "id" });
      }
      // v1 → v2: migrate from single-blob `sync` store to chained
      // `wallet-updates-v1` + `wallet-meta`. The old blob is unsalvageable
      // (a single isolated delta with no chain history), so we drop the
      // store entirely. Existing users will pay one fresh full-scan on next
      // app open — same UX as a brand-new install. credentials store is
      // untouched; the seed survives.
      if (event.oldVersion < 2) {
        if (db.objectStoreNames.contains("sync")) {
          db.deleteObjectStore("sync");
        }
        if (!db.objectStoreNames.contains(UPDATES_STORE)) {
          db.createObjectStore(UPDATES_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Release the connection if another tab triggers an upgrade or delete,
      // so cross-tab teardown (destroyDatabase in wipeWallet) doesn't stall.
      db.onversionchange = () => db.close();
      resolve(db);
    };
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
    const next = { ...existing, ...patch, id: MAIN_KEY, version: SCHEMA_VERSION };
    await promisifyRequest(store.put(next));
    return next;
  });
}

export async function deleteCredentials(db) {
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    await promisifyRequest(store.delete(MAIN_KEY));
  });
}

// ── Chained-Update persistence (wallet-updates-v1) ─────────────────────
//
// Each Update is stored under a key equal to `wollet.status().toString()`
// AT THE MOMENT BEFORE applyUpdate. On cold start, loadPersisted() walks
// the chain by re-reading status after every apply.
//
// Bigint status hashes are stored as decimal strings (BigInts are not
// natively indexable as IDB keys). The Wollet's status() is documented in
// lwk_wasm.d.ts as a `bigint` deterministic hash — strings round-trip
// safely.

export async function getUpdate(db, walletStatus) {
  if (typeof walletStatus !== "string" || walletStatus.length === 0) return null;
  return withStore(db, UPDATES_STORE, "readonly", async store =>
    (await promisifyRequest(store.get(walletStatus))) ?? null
  );
}

export async function putUpdate(db, walletStatus, blob) {
  if (typeof walletStatus !== "string" || walletStatus.length === 0) {
    throw new WalletError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "putUpdate: walletStatus must be a non-empty string"
    );
  }
  if (!blob || typeof blob.byteLength !== "number" || blob.byteLength === 0) {
    throw new WalletError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "putUpdate: blob must be a non-empty typed array"
    );
  }
  const record = { id: walletStatus, updateBlob: blob, savedAt: Date.now() };
  return withStore(db, UPDATES_STORE, "readwrite", async store => {
    await promisifyRequest(store.put(record));
    return record;
  });
}

export async function clearAllUpdates(db) {
  return withStore(db, UPDATES_STORE, "readwrite", async store => {
    await promisifyRequest(store.clear());
  });
}

export async function countUpdates(db) {
  return withStore(db, UPDATES_STORE, "readonly", async store =>
    promisifyRequest(store.count())
  );
}

// ── Sync metadata (wallet-meta) ────────────────────────────────────────
//
// Single-row store ("main") for non-chain data: lastScanAt, lastSuccessAt,
// quotaExceeded flag. Patch-style merge so concurrent partial writes don't
// clobber each other's fields.

export async function readMeta(db) {
  return withStore(db, META_STORE, "readonly", async store =>
    (await promisifyRequest(store.get(MAIN_KEY))) ?? null
  );
}

export async function writeMeta(db, partial) {
  return withStore(db, META_STORE, "readwrite", async store => {
    const existing = (await promisifyRequest(store.get(MAIN_KEY))) ?? null;
    const next = { ...(existing ?? {}), ...partial, id: MAIN_KEY };
    await promisifyRequest(store.put(next));
    return next;
  });
}

export async function deleteMeta(db) {
  return withStore(db, META_STORE, "readwrite", async store => {
    await promisifyRequest(store.delete(MAIN_KEY));
  });
}

export async function hasCredentials(db) {
  const record = await readCredentials(db);
  if (record === null || record.encryptedSeed == null) return false;
  const seed = record.encryptedSeed;
  const len = seed.byteLength ?? seed.length ?? 0;
  return len > 0;
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
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    const existing = await promisifyRequest(store.get(MAIN_KEY));
    if (!existing) return;
    if ((existing.failedPinAttempts ?? 0) === 0) return;
    const next = { ...existing, id: MAIN_KEY, version: SCHEMA_VERSION, failedPinAttempts: 0 };
    await promisifyRequest(store.put(next));
  });
}

export async function incrementFailedPinAttempts(db) {
  return withStore(db, CREDENTIALS_STORE, "readwrite", async store => {
    const existing = await promisifyRequest(store.get(MAIN_KEY));
    if (!existing) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "Cannot increment counter for missing wallet"
      );
    }
    const nextCount = (existing.failedPinAttempts ?? 0) + 1;
    const next = { ...existing, id: MAIN_KEY, version: SCHEMA_VERSION, failedPinAttempts: nextCount };
    await promisifyRequest(store.put(next));
    return nextCount;
  });
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
    req.onblocked = () => reject(
      new WalletError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        "deleteDatabase blocked by another tab"
      )
    );
  });
}
