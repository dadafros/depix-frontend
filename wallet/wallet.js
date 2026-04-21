// Wallet — public API consumed by the rest of the app.
//
// The module keeps the plaintext seed, the Signer, and the Wollet inside a
// closure owned by a factory function. External callers only ever see a
// `Object.freeze()`-d facade, so dumping `wallet.js` via devtools doesn't leak
// the seed directly. A supply-chain compromise in an imported module would
// still be able to reach into that closure via prototype hijacking — this is
// reduced surface, not perfect defense. Runbook covers disclosure.
//
// Every exported method is side-effect-free until it touches IndexedDB or the
// LWK WASM. `unlock()` and `unlockWithPin()` hydrate the Signer; `lock()`
// zeroes the closure.
//
// View-only accessors (`getReceiveAddress`, `getBalances`, `listTransactions`)
// do not require unlock — they work off the plaintext descriptor saved in
// `credentials.descriptor`.

import { WalletError, ERROR_CODES } from "./wallet-errors.js";
import {
  MAX_PIN_ATTEMPTS,
  PIN_RATE_LIMIT_AFTER_ATTEMPT,
  PIN_RATE_LIMIT_MS,
  AUTO_LOCK_MINUTES,
  MIN_PIN_LENGTH
} from "./constants.js";
import {
  openDb,
  readCredentials,
  writeCredentials,
  patchCredentials,
  wipeSensitiveCredentials,
  destroyDatabase,
  resetFailedPinAttempts,
  incrementFailedPinAttempts,
  hasCredentials as storeHasCredentials,
  readSync,
  writeSync
} from "./wallet-store.js";
import {
  assertStrongPin,
  decryptSeed,
  deriveKey,
  encryptSeed,
  randomIv,
  randomSalt
} from "./wallet-crypto.js";
import {
  derivePrfSecret,
  enroll as biometricEnroll,
  importPrfAsAesKey,
  isAvailable as biometricIsAvailable,
  isPrfCredential
} from "./wallet-biometric.js";
import { loadLwk } from "./lwk-loader.js";

const AUTO_LOCK_MS = AUTO_LOCK_MINUTES * 60 * 1000;

function now() {
  return Date.now();
}

function toUint8(buf) {
  if (buf == null) return null;
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (Array.isArray(buf)) return new Uint8Array(buf);
  throw new TypeError("Expected ArrayBuffer, Uint8Array, or Array");
}

// Walks a `Network` factory name into an actual Network. `mainnet` only for
// the production wallet — Sub-fase 2 hardcodes that. Regtest is for tests.
function makeNetwork(lwk, kind) {
  if (kind === "regtest") return lwk.Network.regtestDefault();
  if (kind === "testnet") return lwk.Network.testnet();
  return lwk.Network.mainnet();
}

function buildDescriptorFromMnemonic(lwk, mnemonicStr, network) {
  const mnemonic = new lwk.Mnemonic(mnemonicStr);
  const signer = new lwk.Signer(mnemonic, network);
  const descriptor = signer.wpkhSlip77Descriptor();
  return { signer, mnemonic, descriptor };
}

// Blockstream public Esplora — the free, open endpoint we hardcode by default.
// Can be overridden via `esploraUrl` option (tests + alt networks).
const DEFAULT_ESPLORA_URL_MAINNET = "https://blockstream.info/liquid/api";

export function createWalletModule({
  indexedDbImpl,
  cryptoImpl,
  credentialsImpl,
  lwkLoader,
  clock,
  network = "mainnet",
  esploraUrl,
  esploraClientFactory
} = {}) {
  const lwkLoaderFn = lwkLoader ?? loadLwk;
  const getNow = clock ?? now;

  // Closure state. Null whenever the wallet is locked.
  let dbPromise = null;
  let signer = null;
  let wollet = null;
  let lwkCache = null;
  let lastActivityAt = 0;
  let rateLimitUntil = 0;
  let lastScanAt = 0;
  let appliedCachedUpdate = false;

  function db() {
    if (!dbPromise) dbPromise = openDb(indexedDbImpl);
    return dbPromise;
  }

  async function lwk() {
    if (!lwkCache) lwkCache = await lwkLoaderFn();
    return lwkCache;
  }

  function isUnlocked() {
    if (!signer) return false;
    if (AUTO_LOCK_MS > 0 && getNow() - lastActivityAt > AUTO_LOCK_MS) {
      zeroInMemory();
      return false;
    }
    return true;
  }

  function touch() {
    lastActivityAt = getNow();
  }

  function zeroInMemory() {
    if (signer?.free) {
      try { signer.free(); } catch { /* best effort */ }
    }
    if (wollet?.free) {
      try { wollet.free(); } catch { /* best effort */ }
    }
    signer = null;
    wollet = null;
    appliedCachedUpdate = false;
  }

  async function hasWallet() {
    const database = await db();
    return storeHasCredentials(database);
  }

  async function hasBiometric() {
    const database = await db();
    const record = await readCredentials(database);
    return isPrfCredential(record);
  }

  async function biometricSupported() {
    return biometricIsAvailable();
  }

  async function restoreWollet(descriptorStr) {
    const l = await lwk();
    const desc = new l.WolletDescriptor(descriptorStr);
    const net = makeNetwork(l, network);
    return new l.Wollet(net, desc);
  }

  async function unlockWithMnemonic(mnemonicStr) {
    const l = await lwk();
    const net = makeNetwork(l, network);
    const { signer: s, descriptor } = buildDescriptorFromMnemonic(l, mnemonicStr, net);
    const descriptorStr = descriptor.toString();
    const w = new l.Wollet(net, descriptor);
    zeroInMemory();
    signer = s;
    wollet = w;
    touch();
    return descriptorStr;
  }

  async function createWallet({ pin, enrollBiometric = false, mnemonic } = {}) {
    assertStrongPin(pin);
    const database = await db();
    const existing = await readCredentials(database);
    if (existing?.encryptedSeed) {
      throw new WalletError(
        ERROR_CODES.WALLET_ALREADY_EXISTS,
        "A wallet already exists on this device; wipe or restore instead"
      );
    }
    const l = await lwk();

    const mnemonicObj = mnemonic
      ? new l.Mnemonic(mnemonic.trim().toLowerCase())
      : l.Mnemonic.fromRandom(12);
    const mnemonicStr = mnemonicObj.toString();

    const salt = randomSalt(cryptoImpl);
    const iv = randomIv(cryptoImpl);
    const key = await deriveKey(pin, salt, cryptoImpl);
    const encryptedSeed = await encryptSeed(mnemonicStr, key, iv, cryptoImpl);

    const descriptorStr = await unlockWithMnemonic(mnemonicStr);

    await writeCredentials(database, {
      encryptedSeed,
      salt,
      iv,
      descriptor: descriptorStr,
      failedPinAttempts: 0,
      credentialId: null,
      prfSalt: null,
      wrappedSeedKey: null,
      createdAt: getNow()
    });

    let biometric = null;
    if (enrollBiometric) {
      biometric = await enrollBiometricForSeed(mnemonicStr);
      await patchCredentials(database, {
        credentialId: biometric.credentialId,
        prfSalt: biometric.prfSalt,
        wrappedSeedKey: biometric.wrappedSeedKey
      });
    }

    return {
      mnemonic: mnemonicStr,
      descriptor: descriptorStr,
      hasBiometric: biometric != null
    };
  }

  async function restoreWallet({ mnemonic, pin, enrollBiometric = false } = {}) {
    if (typeof mnemonic !== "string" || !mnemonic.trim()) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "mnemonic must be a non-empty string"
      );
    }
    assertStrongPin(pin);
    const database = await db();
    const l = await lwk();

    // Parse the mnemonic before touching storage — constructor throws on
    // invalid words / checksum.
    let mnemonicObj;
    try {
      mnemonicObj = new l.Mnemonic(mnemonic.trim().toLowerCase());
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "Invalid BIP39 mnemonic",
        err
      );
    }

    const mnemonicStr = mnemonicObj.toString();

    // Plan Sub-fase 2: if a descriptor already exists from a prior (wiped)
    // wallet and it differs from the one derived here, the user likely typed
    // the wrong mnemonic. Compute the descriptor WITHOUT mutating closure
    // state, check for mismatch, then actually unlock only if it matches.
    const l2 = await lwk();
    const net2 = makeNetwork(l2, network);
    const { signer: probeSigner, mnemonic: probeMnemonic, descriptor: probeDesc } = buildDescriptorFromMnemonic(l2, mnemonicStr, net2);
    const descriptorStr = probeDesc.toString();
    if (probeSigner?.free) { try { probeSigner.free(); } catch { /* best effort */ } }
    if (probeDesc?.free) { try { probeDesc.free(); } catch { /* best effort */ } }
    if (probeMnemonic?.free) { try { probeMnemonic.free(); } catch { /* best effort */ } }

    const existing = await readCredentials(database);
    if (existing?.descriptor && existing.descriptor !== descriptorStr) {
      throw new WalletError(
        ERROR_CODES.DESCRIPTOR_MISMATCH,
        "This mnemonic would produce a different wallet than the one previously on this device"
      );
    }

    // Now it's safe to populate the closure.
    await unlockWithMnemonic(mnemonicStr);

    const salt = randomSalt(cryptoImpl);
    const iv = randomIv(cryptoImpl);
    const key = await deriveKey(pin, salt, cryptoImpl);
    const encryptedSeed = await encryptSeed(mnemonicStr, key, iv, cryptoImpl);

    await writeCredentials(database, {
      encryptedSeed,
      salt,
      iv,
      descriptor: descriptorStr,
      failedPinAttempts: 0,
      credentialId: null,
      prfSalt: null,
      wrappedSeedKey: null,
      createdAt: existing?.createdAt ?? getNow()
    });

    let biometric = null;
    if (enrollBiometric) {
      biometric = await enrollBiometricForSeed(mnemonicStr);
      await patchCredentials(database, {
        credentialId: biometric.credentialId,
        prfSalt: biometric.prfSalt,
        wrappedSeedKey: biometric.wrappedSeedKey
      });
    }

    return {
      descriptor: descriptorStr,
      hasBiometric: biometric != null
    };
  }

  async function enrollBiometricForSeed(mnemonicStr) {
    const { credentialId, prfSalt, prfSecret } = await biometricEnroll({ credentialsImpl });
    const prfKey = await importPrfAsAesKey(prfSecret, cryptoImpl);
    const wrappedIv = randomIv(cryptoImpl);
    const wrappedCiphertext = await encryptSeed(mnemonicStr, prfKey, wrappedIv, cryptoImpl);
    // Pack [iv || ciphertext] so the unlock path can split them without a
    // second stored field. IV is the first 12 bytes.
    const wrappedSeedKey = new Uint8Array(wrappedIv.length + wrappedCiphertext.length);
    wrappedSeedKey.set(wrappedIv, 0);
    wrappedSeedKey.set(wrappedCiphertext, wrappedIv.length);
    return { credentialId, prfSalt, wrappedSeedKey };
  }

  async function unlockWithPin(pin) {
    if (typeof pin !== "string" || pin.length < MIN_PIN_LENGTH) {
      throw new WalletError(
        ERROR_CODES.WRONG_PIN,
        "PIN must be a string of at least 6 digits"
      );
    }
    const database = await db();
    const record = await readCredentials(database);
    if (!record?.encryptedSeed) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    if (rateLimitUntil > getNow()) {
      throw new WalletError(
        ERROR_CODES.PIN_RATE_LIMITED,
        "Too many attempts, wait before retrying"
      );
    }
    const key = await deriveKey(pin, record.salt, cryptoImpl);
    let mnemonicStr;
    try {
      mnemonicStr = await decryptSeed(record.encryptedSeed, key, record.iv, cryptoImpl);
    } catch (err) {
      const attempts = await incrementFailedPinAttempts(database);
      if (attempts >= PIN_RATE_LIMIT_AFTER_ATTEMPT) {
        rateLimitUntil = getNow() + PIN_RATE_LIMIT_MS;
      }
      if (attempts >= MAX_PIN_ATTEMPTS) {
        await wipeSensitiveCredentials(database);
        zeroInMemory();
        rateLimitUntil = 0;
        throw new WalletError(
          ERROR_CODES.WALLET_WIPED,
          "Too many wrong attempts — wallet wiped from this device",
          err
        );
      }
      throw new WalletError(
        ERROR_CODES.WRONG_PIN,
        `Wrong PIN (${MAX_PIN_ATTEMPTS - attempts} attempts remaining)`,
        err
      );
    }
    await resetFailedPinAttempts(database);
    rateLimitUntil = 0;
    const derivedDescriptor = await unlockWithMnemonic(mnemonicStr);
    return { descriptor: derivedDescriptor };
  }

  async function unlockWithBiometric() {
    const database = await db();
    const record = await readCredentials(database);
    if (!record?.encryptedSeed) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    if (!isPrfCredential(record)) {
      throw new WalletError(
        ERROR_CODES.BIOMETRIC_UNAVAILABLE,
        "Biometric unlock not configured"
      );
    }
    const prfSecret = await derivePrfSecret({
      credentialId: record.credentialId,
      prfSalt: record.prfSalt,
      credentialsImpl
    });
    const prfKey = await importPrfAsAesKey(prfSecret, cryptoImpl);
    const wrapped = toUint8(record.wrappedSeedKey);
    const iv = wrapped.slice(0, 12);
    const ciphertext = wrapped.slice(12);
    let mnemonicStr;
    try {
      mnemonicStr = await decryptSeed(ciphertext, prfKey, iv, cryptoImpl);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.BIOMETRIC_REJECTED,
        "Biometric unlock failed to decrypt seed",
        err
      );
    }
    const derivedDescriptor = await unlockWithMnemonic(mnemonicStr);
    await resetFailedPinAttempts(database);
    rateLimitUntil = 0;
    return { descriptor: derivedDescriptor };
  }

  // High-level unlock — tries biometric first, falls back to a caller-
  // supplied PIN getter. The UI decides what to do if biometric is
  // unavailable or rejected (usually: prompt for PIN).
  async function unlock({ pinFallback } = {}) {
    const database = await db();
    const record = await readCredentials(database);
    if (!record?.encryptedSeed) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    if (isPrfCredential(record)) {
      try {
        return await unlockWithBiometric();
      } catch (err) {
        if (!pinFallback) throw err;
      }
    }
    if (typeof pinFallback === "function") {
      const pin = await pinFallback();
      return unlockWithPin(pin);
    }
    throw new WalletError(
      ERROR_CODES.WALLET_LOCKED,
      "Biometric unavailable and no PIN fallback provided"
    );
  }

  function lock() {
    zeroInMemory();
  }

  async function getDescriptor() {
    const database = await db();
    const record = await readCredentials(database);
    return record?.descriptor ?? null;
  }

  async function ensureViewWollet() {
    if (wollet) return wollet;
    const descriptorStr = await getDescriptor();
    if (!descriptorStr) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    wollet = await restoreWollet(descriptorStr);
    // Rehydrate from the cached Update blob if we have one — gives the UI
    // an instant first paint with last-known balances while a fresh scan
    // runs in the background. Failure here is non-fatal: corrupt blob is
    // just dropped on the next successful sync.
    if (!appliedCachedUpdate) {
      try {
        const database = await db();
        const syncRecord = await readSync(database);
        if (syncRecord?.updateBlob) {
          const l = await lwk();
          const bytes = toUint8(syncRecord.updateBlob);
          const update = new l.Update(bytes);
          wollet.applyUpdate(update);
          if (typeof syncRecord.lastScanAt === "number") {
            lastScanAt = syncRecord.lastScanAt;
          }
        }
      } catch {
        // swallow — cached blob is best-effort.
      }
      appliedCachedUpdate = true;
    }
    return wollet;
  }

  async function esploraClient(l, net) {
    if (typeof esploraClientFactory === "function") {
      return esploraClientFactory(l, net);
    }
    const url = esploraUrl ?? (network === "mainnet" ? DEFAULT_ESPLORA_URL_MAINNET : null);
    if (!url) {
      // Let LWK pick its default for non-mainnet networks (testnet, regtest).
      return net.defaultEsploraClient();
    }
    return new l.EsploraClient(net, url, false, 4, false);
  }

  // Drives a fresh Esplora scan and persists the resulting Update blob so
  // the next mount can paint immediately. Idempotent; the UI calls it on
  // mount and on a 30s timer while the view is visible.
  async function syncWallet() {
    const w = await ensureViewWollet();
    const l = await lwk();
    const net = makeNetwork(l, network);
    let client;
    try {
      client = await esploraClient(l, net);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.ESPLORA_UNAVAILABLE,
        "Failed to create Esplora client",
        err
      );
    }
    let update;
    try {
      update = await client.fullScan(w);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.ESPLORA_UNAVAILABLE,
        "Failed to sync with Esplora",
        err
      );
    } finally {
      if (client?.free) {
        try { client.free(); } catch { /* best effort */ }
      }
    }
    const scanAt = getNow();
    if (update) {
      w.applyUpdate(update);
      try {
        const bytes = update.serialize();
        const database = await db();
        await writeSync(database, { updateBlob: bytes, lastScanAt: scanAt });
      } catch {
        // If persistence fails (quota, private mode), the scan still applied
        // in memory — next mount just has no warm start.
      }
      if (update.free) {
        try { update.free(); } catch { /* best effort */ }
      }
    } else {
      // No changes since last scan — still bump the timestamp so the UI
      // can show "synced N seconds ago" accurately.
      try {
        const database = await db();
        await writeSync(database, {
          updateBlob: (await readSync(database))?.updateBlob ?? null,
          lastScanAt: scanAt
        });
      } catch { /* best effort */ }
    }
    lastScanAt = scanAt;
    return { lastScanAt, changed: Boolean(update) };
  }

  function getLastScanAt() {
    return lastScanAt;
  }

  async function getReceiveAddress({ index } = {}) {
    const w = await ensureViewWollet();
    const result = w.address(index ?? null);
    return result.address().toString();
  }

  async function getBalances() {
    const w = await ensureViewWollet();
    return w.balance();
  }

  async function listTransactions() {
    const w = await ensureViewWollet();
    return w.transactions();
  }

  async function exportMnemonic(pin) {
    const database = await db();
    const record = await readCredentials(database);
    if (!record?.encryptedSeed) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    if (rateLimitUntil > getNow()) {
      throw new WalletError(
        ERROR_CODES.PIN_RATE_LIMITED,
        "Too many attempts, wait before retrying"
      );
    }
    const key = await deriveKey(pin, record.salt, cryptoImpl);
    let mnemonicStr;
    try {
      mnemonicStr = await decryptSeed(record.encryptedSeed, key, record.iv, cryptoImpl);
    } catch (err) {
      // Export is a critical operation — use the same counter so a wrong PIN
      // here counts toward wipe. Users get the same safety net as unlock.
      const attempts = await incrementFailedPinAttempts(database);
      if (attempts >= PIN_RATE_LIMIT_AFTER_ATTEMPT) {
        rateLimitUntil = getNow() + PIN_RATE_LIMIT_MS;
      }
      if (attempts >= MAX_PIN_ATTEMPTS) {
        await wipeSensitiveCredentials(database);
        zeroInMemory();
        rateLimitUntil = 0;
        throw new WalletError(
          ERROR_CODES.WALLET_WIPED,
          "Too many wrong attempts — wallet wiped from this device",
          err
        );
      }
      throw err;
    }
    await resetFailedPinAttempts(database);
    rateLimitUntil = 0;
    return mnemonicStr;
  }

  async function wipeWallet(pin) {
    // Require PIN as a confirmation gate — prevents accidental button presses.
    await exportMnemonic(pin);
    const database = await db();
    zeroInMemory();
    // Close the handle and invalidate the cached promise BEFORE destroying;
    // deleteDatabase blocks as long as any connection is open.
    dbPromise = null;
    database.close();
    await destroyDatabase(indexedDbImpl);
  }

  // Updates the biometric enrollment after the wallet was created (e.g. user
  // skipped it and later enables it from settings).
  async function addBiometric(pin) {
    const mnemonicStr = await exportMnemonic(pin);
    const biometric = await enrollBiometricForSeed(mnemonicStr);
    const database = await db();
    await patchCredentials(database, {
      credentialId: biometric.credentialId,
      prfSalt: biometric.prfSalt,
      wrappedSeedKey: biometric.wrappedSeedKey
    });
  }

  async function removeBiometric() {
    const database = await db();
    await patchCredentials(database, {
      credentialId: null,
      prfSalt: null,
      wrappedSeedKey: null
    });
  }

  // Generates a fresh BIP39 mnemonic WITHOUT persisting it. Used by the
  // onboarding UI so the user can see/verify the 12 words before committing
  // anything to IndexedDB. `createWallet({ mnemonic })` persists it later.
  async function generateMnemonic() {
    const l = await lwk();
    return l.Mnemonic.fromRandom(12).toString();
  }

  // Derive the wallet's CT descriptor from a mnemonic WITHOUT persisting or
  // unlocking. Used by the onboarding UI to show a fingerprint of the wallet
  // identity on the seed-display screen (so the user writes it down alongside
  // the 12 words) and on the restore confirmation screen (so the user verifies
  // the restored wallet matches what they wrote down).
  //
  // Same validation contract as validateMnemonic — throws INVALID_MNEMONIC on
  // non-string / empty / bad-checksum input.
  async function deriveDescriptor(mnemonicStr) {
    if (typeof mnemonicStr !== "string" || !mnemonicStr.trim()) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "mnemonic must be a non-empty string"
      );
    }
    const l = await lwk();
    let mnemonicObj;
    try {
      mnemonicObj = new l.Mnemonic(mnemonicStr.trim().toLowerCase());
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "Invalid BIP39 mnemonic",
        err
      );
    }
    const net = makeNetwork(l, network);
    const { signer, mnemonic: innerMnemonic, descriptor } = buildDescriptorFromMnemonic(l, mnemonicObj.toString(), net);
    const descStr = descriptor.toString();
    // Free every WASM-owned handle this derivation allocated. The comment
    // above claims full cleanup — keep it honest: signer, the inner Mnemonic
    // built by `buildDescriptorFromMnemonic`, the returned descriptor, and
    // the outer validator-mnemonic all hold WASM memory until .free()'d.
    if (signer?.free) { try { signer.free(); } catch { /* best effort */ } }
    if (descriptor?.free) { try { descriptor.free(); } catch { /* best effort */ } }
    if (innerMnemonic?.free) { try { innerMnemonic.free(); } catch { /* best effort */ } }
    if (mnemonicObj?.free) { try { mnemonicObj.free(); } catch { /* best effort */ } }
    return descStr;
  }

  // Checksum-validate a user-typed mnemonic WITHOUT persisting or unlocking.
  // Used by the restore UI's "Validar e avançar" button so a bad checksum
  // surfaces on the input screen (where "palavras erradas" is unambiguous)
  // instead of 2 screens later after the user has typed a PIN.
  // Throws INVALID_MNEMONIC on bad input or bad BIP39 checksum.
  async function validateMnemonic(mnemonicStr) {
    if (typeof mnemonicStr !== "string" || !mnemonicStr.trim()) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "mnemonic must be a non-empty string"
      );
    }
    const l = await lwk();
    let mnemonicObj;
    try {
      mnemonicObj = new l.Mnemonic(mnemonicStr.trim().toLowerCase());
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.INVALID_MNEMONIC,
        "Invalid BIP39 mnemonic",
        err
      );
    }
    if (mnemonicObj?.free) {
      try { mnemonicObj.free(); } catch { /* best effort */ }
    }
  }

  return Object.freeze({
    hasWallet,
    hasBiometric,
    biometricSupported,
    isUnlocked,
    generateMnemonic,
    validateMnemonic,
    deriveDescriptor,
    createWallet,
    restoreWallet,
    unlock,
    unlockWithPin,
    unlockWithBiometric,
    lock,
    getReceiveAddress,
    getBalances,
    listTransactions,
    syncWallet,
    getLastScanAt,
    getDescriptor,
    exportMnemonic,
    wipeWallet,
    addBiometric,
    removeBiometric,
    touch,
    _zeroInMemory: zeroInMemory
  });
}

// Default singleton used by the real app. Tests use `createWalletModule` with
// mocks injected.
let defaultWallet = null;
export function getDefaultWallet() {
  if (!defaultWallet) defaultWallet = createWalletModule();
  return defaultWallet;
}

// Convenience re-exports for consumers.
export { WalletError, ERROR_CODES } from "./wallet-errors.js";
