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
  writeSync,
  patchSync
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
import { ASSETS } from "./asset-registry.js";

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

// Public Liquid Esplora endpoints we fall through on rate-limit or network
// failure. Both speak the Esplora REST API that LWK expects. Ordered by
// preference — Blockstream first (authoritative, well-monitored), Liquid.network
// (mempool.space's Liquid instance) second.
//
// Rationale for fallback vs. a single upstream: users behind CGNAT / shared
// mobile carrier NATs share an IP with dozens-to-hundreds of other Blockstream
// callers, so their "per-IP" quota can be exhausted by strangers. Falling
// through to a different provider with a fresh IP quota unblocks those users
// without us running our own Esplora.
//
// Direct-from-client (each browser → Esplora) stays the right topology — proxying
// through our backend would concentrate all traffic through a small Vercel IP
// pool and make the rate-limit problem worse, not better, because Liquid
// addresses are user-unique so there is no cross-user cache hit to amortize.
//
// Can be overridden with `esploraUrl` (single URL, legacy) or `esploraProviders`
// (array of {name, url}) for tests and alt networks.
const DEFAULT_PROVIDERS_MAINNET = Object.freeze([
  Object.freeze({ name: "Blockstream", url: "https://blockstream.info/liquid/api" }),
  Object.freeze({ name: "Liquid.network", url: "https://liquid.network/api" })
]);

// Cheap mirror of `hasWallet()` into localStorage. IDB remains the source of
// truth; this flag lets script.js answer "should I even load the wallet
// bundle?" synchronously, so users without a wallet never download the
// ~197kb bundle just to check. Set on create/restore, cleared on any wipe
// path. See script.js:refreshWalletModeAvailability for the read site.
const WALLET_EXISTS_FLAG = "depix-wallet-exists";

function markWalletExists() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(WALLET_EXISTS_FLAG, "1");
    }
  } catch { /* private mode / disabled */ }
}

function clearWalletExistsFlag() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(WALLET_EXISTS_FLAG);
    }
  } catch { /* private mode / disabled */ }
}

// LWK wraps Esplora fetch errors as a plain `Error` whose `message` contains
// the upstream status (e.g. "error response 429 Too Many Requests" on 0.16.x).
// We pattern-match on the stringified error because LWK does not expose a
// typed discriminator; a breaking upstream change would silently degrade
// this into the generic ESPLORA_UNAVAILABLE path, which is acceptable — the
// 60s backoff UX is a nicety, not a correctness guarantee.
function isRateLimitError(err) {
  let cur = err;
  for (let i = 0; i < 4 && cur; i++) {
    const msg = String(cur.message ?? cur ?? "").toLowerCase();
    if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
      return true;
    }
    cur = cur.cause;
  }
  return false;
}

export function createWalletModule({
  indexedDbImpl,
  cryptoImpl,
  credentialsImpl,
  lwkLoader,
  clock,
  network = "mainnet",
  esploraUrl,
  esploraProviders,
  esploraClientFactory,
  syncTimeoutMs
} = {}) {
  const lwkLoaderFn = lwkLoader ?? loadLwk;
  const getNow = clock ?? now;

  // Closure state. Null whenever the wallet is locked.
  let dbPromise = null;
  let signer = null;
  let wollet = null;
  let lwkCache = null;
  // Single in-flight syncWallet promise. Concurrent callers (mount +
  // 30s timer + visibilitychange) share this promise so a fresh wallet's
  // gap-limit fullScan (~40 Esplora requests) runs exactly once instead
  // of N times stacked, which previously triggered the 429 cascade we
  // saw in dev.
  let syncPromise = null;
  let lastActivityAt = 0;
  let rateLimitUntil = 0;
  let lastScanAt = 0;
  let appliedCachedUpdate = false;
  // Index into the provider list (see DEFAULT_PROVIDERS_MAINNET) of the most
  // recent provider that returned a successful scan. Persists for the lifetime
  // of this module instance so consecutive syncs don't retry known-failing
  // providers first. Reset on module recreate (page reload).
  let lastGoodProviderIndex = 0;
  // Periodic-rediscovery counter. Without this, if provider[0] (Blockstream)
  // 429s on the first sync of a session, we stick to the fallback forever
  // even after Blockstream recovers. Every N successful syncs we force the
  // next attempt to start at index 0 so a transient 429 doesn't produce a
  // permanent demotion of the preferred provider for the rest of the session.
  let syncsSinceLastRediscovery = 0;
  const REDISCOVERY_INTERVAL = 10;

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
    const exists = await storeHasCredentials(database);
    // Backfill the lazy flag for installs that pre-date it: if IDB has a
    // wallet but the flag is missing (older app version, first run post-
    // upgrade), set it so subsequent #home visits skip the bundle download.
    if (exists) markWalletExists();
    return exists;
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
    markWalletExists();

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
    markWalletExists();

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
        clearWalletExistsFlag();
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

  // Resolve the provider list. Priority:
  //   1. `esploraProviders` — explicit array of {name, url}. Tests use this.
  //   2. `esploraUrl` — legacy single-URL override. Wrapped in a 1-item list.
  //   3. `DEFAULT_PROVIDERS_MAINNET` on mainnet; empty on other networks
  //      (LWK picks its own default client).
  function resolveProviders() {
    if (Array.isArray(esploraProviders) && esploraProviders.length > 0) {
      return esploraProviders;
    }
    if (esploraUrl) {
      return [{ name: "custom", url: esploraUrl }];
    }
    if (network === "mainnet") return DEFAULT_PROVIDERS_MAINNET;
    return [];
  }

  // Build one EsploraClient for a specific provider. Concurrency=1 keeps a
  // gap-limit scan (~40 address lookups) serial so bursts don't trip per-IP
  // limits, which previously wedged LWK in an internal retry loop. The
  // injected `esploraClientFactory` gets the provider metadata so tests can
  // fan out per-provider behavior.
  async function buildEsploraClient(l, net, provider) {
    if (typeof esploraClientFactory === "function") {
      return esploraClientFactory(l, net, provider);
    }
    return new l.EsploraClient(net, provider.url, false, 1, false);
  }

  // Outer wall-clock guard on a single provider's fullScan. LWK 0.16.x retries
  // 429s internally without surfacing the error, which can wedge the promise
  // forever. We cap each provider attempt at 60s; the synthetic error message
  // contains "rate limit" so isRateLimitError() classifies it and the
  // fallback loop moves on to the next provider.
  //
  // 60s (not 30s) tolerates legitimately slow scans on bad mobile networks —
  // a fresh wallet's ~40-address gap-limit serial scan can genuinely take
  // 40-50s on congested 3G/4G without any rate-limit involvement. A 30s
  // timeout in that scenario would false-positive into the exponential
  // backoff, stranding the user in a 10-min cool-down when their only
  // "problem" was a slow cell tower. The cost is a higher worst-case
  // wait (2 providers × 60s = 120s) when both upstreams are genuinely
  // hung, but the cached balance stays on screen the whole time and the
  // "Tentar novamente" CTA lets users escape the wait manually.
  //
  // Overridable via the `syncTimeoutMs` option so tests can assert the
  // timeout path deterministically without 60s real-time waits.
  const SYNC_TIMEOUT_MS = typeof syncTimeoutMs === "number" ? syncTimeoutMs : 60_000;

  // Run fullScan against one client, enforced by the 30s timeout. Returns the
  // Update on success; throws the underlying error on failure (the caller
  // decides whether to fall through to the next provider or surface it).
  async function runSingleScan(client, w) {
    let timer;
    try {
      return await Promise.race([
        client.fullScan(w),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`fullScan timed out after ${SYNC_TIMEOUT_MS}ms — upstream likely rate limit`));
          }, SYNC_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Drives a fresh Esplora scan and persists the resulting Update blob so
  // the next mount can paint immediately. Dedup'd via `syncPromise` — a
  // second caller while the first is in-flight receives the same promise
  // instead of starting a parallel scan. This prevents the 429 cascade
  // where mount + 30s timer + visibilitychange stacked 3 concurrent
  // fullScans (~40 Esplora requests each) on the same addresses.
  //
  // Falls through a provider list (DEFAULT_PROVIDERS_MAINNET by default):
  // each provider gets one 30s attempt; rate-limit or network error moves
  // to the next. Returns as soon as any provider succeeds, and records the
  // winning index so the next sync starts there (warm path). Throws only
  // if every provider fails — ESPLORA_RATE_LIMITED if at least one was
  // rate-limited (UI triggers backoff), ESPLORA_UNAVAILABLE otherwise.
  function syncWallet() {
    if (syncPromise) return syncPromise;
    syncPromise = syncWalletInner().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }

  async function syncWalletInner() {
    const w = await ensureViewWollet();
    const l = await lwk();
    const net = makeNetwork(l, network);
    const providers = resolveProviders();

    // Degenerate case: no provider list (non-mainnet without override). Use
    // LWK's network-default client and preserve the old single-attempt
    // semantics — still guarded by the 30s timeout.
    if (providers.length === 0) {
      const client = await net.defaultEsploraClient();
      try {
        const update = await runSingleScan(client, w);
        return await persistScan(w, update);
      } catch (err) {
        if (isRateLimitError(err)) {
          throw new WalletError(ERROR_CODES.ESPLORA_RATE_LIMITED, "Esplora rate-limited the sync (HTTP 429)", err);
        }
        throw new WalletError(ERROR_CODES.ESPLORA_UNAVAILABLE, "Failed to sync with Esplora", err);
      } finally {
        if (client?.free) {
          try { client.free(); } catch { /* best effort */ }
        }
      }
    }

    // Start from the last provider we saw succeed (or 0 on cold start), then
    // wrap around. Every REDISCOVERY_INTERVAL syncs we force startIndex=0 so
    // a once-failed preferred provider eventually gets re-tested after
    // recovery — otherwise a single 429 on Blockstream at mount time would
    // demote it for the rest of the session.
    const forceRediscovery = syncsSinceLastRediscovery >= REDISCOVERY_INTERVAL;
    const startIndex = forceRediscovery
      ? 0
      : Math.min(lastGoodProviderIndex, providers.length - 1);
    const errors = [];
    let anyRateLimited = false;

    for (let step = 0; step < providers.length; step++) {
      const idx = (startIndex + step) % providers.length;
      const provider = providers[idx];
      let client;
      try {
        client = await buildEsploraClient(l, net, provider);
      } catch (err) {
        errors.push({ provider, err });
        continue;
      }
      try {
        const update = await runSingleScan(client, w);
        lastGoodProviderIndex = idx;
        syncsSinceLastRediscovery = forceRediscovery ? 0 : syncsSinceLastRediscovery + 1;
        return await persistScan(w, update);
      } catch (err) {
        if (isRateLimitError(err)) anyRateLimited = true;
        errors.push({ provider, err });
      } finally {
        if (client?.free) {
          try { client.free(); } catch { /* best effort */ }
        }
      }
    }

    // Every provider failed. Surface rate-limit if any of them hit 429 (so
    // the UI applies its exponential backoff); otherwise a generic network
    // error code so the UI shows the cached balance + manual-retry CTA.
    const lastErr = errors.length > 0 ? errors[errors.length - 1].err : new Error("no providers");
    const summary = errors.map(e => `${e.provider.name}: ${String(e.err?.message ?? e.err)}`).join(" | ");
    if (anyRateLimited) {
      throw new WalletError(
        ERROR_CODES.ESPLORA_RATE_LIMITED,
        `All Esplora providers rate-limited (${summary})`,
        lastErr
      );
    }
    throw new WalletError(
      ERROR_CODES.ESPLORA_UNAVAILABLE,
      `All Esplora providers failed (${summary})`,
      lastErr
    );
  }

  // Persist an Update produced by a successful scan and return the result
  // the caller sees. Factored out of syncWalletInner so both the
  // provider-fallback loop and the no-provider branch share the same
  // persistence semantics.
  async function persistScan(w, update) {
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
      // No changes since last scan — still bump the timestamp so the UI can
      // show "synced N seconds ago" accurately. Uses `patchSync` so the read
      // and write happen in a single IDB transaction; a separate readSync +
      // writeSync pair would race with a sibling tab that wrote a newer
      // updateBlob in between, and we'd overwrite it with the stale value.
      try {
        const database = await db();
        await patchSync(database, { lastScanAt: scanAt });
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
        clearWalletExistsFlag();
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
    clearWalletExistsFlag();
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

  function resolveAsset(assetKey) {
    if (!assetKey) return null;
    const normalized = String(assetKey).toUpperCase();
    if (normalized === "LBTC" || normalized === "L-BTC") return ASSETS.LBTC;
    if (normalized === "DEPIX") return ASSETS.DEPIX;
    if (normalized === "USDT") return ASSETS.USDT;
    return null;
  }

  function assertPositiveSats(value) {
    if (value === null || value === undefined) {
      throw new WalletError(
        ERROR_CODES.INVALID_AMOUNT,
        "amountSats is required"
      );
    }
    let asBig;
    try {
      if (typeof value === "bigint") {
        asBig = value;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw new Error("not finite");
        }
        asBig = BigInt(Math.trunc(value));
      } else {
        asBig = BigInt(value);
      }
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.INVALID_AMOUNT,
        "amountSats must be a positive integer (BigInt or Number)",
        err
      );
    }
    if (asBig <= 0n) {
      throw new WalletError(
        ERROR_CODES.INVALID_AMOUNT,
        "amountSats must be greater than zero"
      );
    }
    return asBig;
  }

  function extractFeeFromPset(pset, w) {
    try {
      const details = w.psetDetails(pset);
      const bal = details?.balance?.();
      const fee = bal?.fee?.();
      if (typeof fee === "bigint") return fee;
    } catch {
      // Fee introspection is best-effort; the UI shows "—" when it fails.
    }
    return null;
  }

  // Builds an unsigned PSET for a send without requiring unlock. Running
  // coin selection and computing the fee is a view-only operation — we only
  // need the descriptor-based Wollet, not the Signer. The returned pset is
  // meant to be handed to `confirmSend()` after the user authorizes the send.
  async function prepareSend({ asset, amountSats, destAddr, sendAll = false, feeRate } = {}) {
    const hasW = await hasWallet();
    if (!hasW) {
      throw new WalletError(
        ERROR_CODES.WALLET_NOT_FOUND,
        "No wallet on this device"
      );
    }
    const resolved = resolveAsset(asset);
    if (!resolved) {
      throw new WalletError(
        ERROR_CODES.UNSUPPORTED_ASSET,
        `Asset "${asset}" is not supported`
      );
    }
    if (sendAll && resolved !== ASSETS.LBTC) {
      throw new WalletError(
        ERROR_CODES.SENDALL_NOT_SUPPORTED,
        "sendAll is only supported for L-BTC"
      );
    }
    let amount = null;
    if (!sendAll) {
      amount = assertPositiveSats(amountSats);
    }
    if (typeof destAddr !== "string" || !destAddr.trim()) {
      throw new WalletError(
        ERROR_CODES.INVALID_ADDRESS,
        "destAddr must be a non-empty string"
      );
    }
    const l = await lwk();
    const net = makeNetwork(l, network);
    let addr;
    try {
      addr = new l.Address(destAddr.trim());
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.INVALID_ADDRESS,
        "Destination address is not a valid Liquid address",
        err
      );
    }
    const w = await ensureViewWollet();
    // Diagnostic snapshot — written to console the first time finish() fails
    // so we can see what LWK was looking at when it rejected the build.
    const debugState = () => {
      try {
        const balance = w.balance();
        const balanceEntries = typeof balance?.entries === "function" ? balance.entries() : [];
        const utxos = typeof w.utxos === "function" ? w.utxos() : [];
        return {
          network,
          asset: resolved.symbol,
          assetId: resolved.id,
          amountSats: amount?.toString?.() ?? null,
          sendAll,
          destAddrLen: destAddr.trim().length,
          destAddrPrefix: destAddr.trim().slice(0, 8),
          balanceEntries: Array.from(balanceEntries).map(([k, v]) => [k?.toString?.(), v?.toString?.()]),
          utxoCount: Array.isArray(utxos) ? utxos.length : null
        };
      } catch (e) {
        return { debugStateError: String(e?.message ?? e) };
      }
    };
    const builder = new l.TxBuilder(net);
    if (typeof feeRate === "number" && Number.isFinite(feeRate) && feeRate > 0) {
      builder.feeRate(feeRate);
    }
    if (sendAll) {
      builder.drainLbtcWallet();
      builder.drainLbtcTo(addr);
    } else if (resolved === ASSETS.LBTC) {
      builder.addLbtcRecipient(addr, amount);
    } else {
      const assetId = new l.AssetId(resolved.id);
      builder.addRecipient(addr, amount, assetId);
    }
    let pset;
    try {
      pset = builder.finish(w);
    } catch (err) {
      try { console.error("[wallet.prepareSend] finish() threw", err, "debugState:", debugState()); } catch { /* no-op */ }
      const rawMsg = String(err?.message ?? err ?? "");
      const msg = rawMsg.toLowerCase();
      // LWK surfaces fee-starvation as the generic "InsufficientFunds" error,
      // but the distinguishing detail is that the wallet has the asset being
      // sent yet no L-BTC for the fee. Callers see a clearer message.
      if (
        msg.includes("fee") ||
        msg.includes("policy asset") ||
        msg.includes("lbtc") ||
        msg.includes("l-btc")
      ) {
        throw new WalletError(
          ERROR_CODES.INSUFFICIENT_LBTC_FOR_FEE,
          "Not enough L-BTC to pay the network fee",
          err
        );
      }
      if (msg.includes("insufficient") || msg.includes("not enough")) {
        throw new WalletError(
          ERROR_CODES.INSUFFICIENT_FUNDS,
          "Not enough funds for this send",
          err
        );
      }
      // Surface the raw LWK message so the UNKNOWN branch stops rendering a
      // generic "Failed to build the transaction" when the real cause would
      // have told us something actionable.
      throw new WalletError(
        ERROR_CODES.UNKNOWN,
        rawMsg ? `Failed to build the transaction: ${rawMsg}` : "Failed to build the transaction",
        err
      );
    }
    const feeSats = extractFeeFromPset(pset, w);
    return {
      psetBase64: pset.toString(),
      feeSats,
      amountSats: amount,
      assetId: resolved.id,
      assetSymbol: resolved.symbol,
      destAddr: destAddr.trim(),
      sendAll: Boolean(sendAll)
    };
  }

  // Signs a previously-prepared PSET with the in-memory Signer, finalizes via
  // the view Wollet, and broadcasts through Esplora. Requires unlock — the
  // Signer lives only in the closure and is nulled by `lock()`.
  async function confirmSend(psetBase64) {
    if (!isUnlocked()) {
      throw new WalletError(
        ERROR_CODES.WALLET_LOCKED,
        "Wallet must be unlocked before confirming a send"
      );
    }
    if (typeof psetBase64 !== "string" || !psetBase64) {
      throw new WalletError(
        ERROR_CODES.UNKNOWN,
        "psetBase64 must be a non-empty string"
      );
    }
    const l = await lwk();
    const net = makeNetwork(l, network);
    let pset;
    try {
      pset = new l.Pset(psetBase64);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.UNKNOWN,
        "Invalid PSET string",
        err
      );
    }
    const w = await ensureViewWollet();
    let signed;
    try {
      signed = signer.sign(pset);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.UNKNOWN,
        "Failed to sign the transaction",
        err
      );
    }
    let finalized;
    try {
      finalized = w.finalize(signed);
    } catch (err) {
      throw new WalletError(
        ERROR_CODES.UNKNOWN,
        "Failed to finalize the signed transaction",
        err
      );
    }
    // Broadcast through the same provider list used by syncWallet. Prefer the
    // last-good provider (set by the sync loop), fall through to the rest on
    // network/rate-limit failure, and surface BROADCAST_FAILED only after every
    // provider refused the tx — a broadcast refused by the first provider but
    // accepted by the second is still a successful broadcast.
    const providers = resolveProviders();
    let txidStr = null;
    const broadcastErrors = [];
    const startIndex = providers.length > 0
      ? Math.min(lastGoodProviderIndex, providers.length - 1)
      : 0;
    const attempts = providers.length > 0 ? providers.length : 1;
    for (let step = 0; step < attempts; step++) {
      const provider = providers.length > 0
        ? providers[(startIndex + step) % providers.length]
        : null;
      let client;
      try {
        client = provider
          ? await buildEsploraClient(l, net, provider)
          : await net.defaultEsploraClient();
      } catch (err) {
        broadcastErrors.push({ provider, err });
        continue;
      }
      try {
        const txid = await client.broadcast(finalized);
        txidStr = typeof txid === "string" ? txid : txid?.toString?.() ?? "";
        break;
      } catch (err) {
        broadcastErrors.push({ provider, err });
      } finally {
        if (client?.free) {
          try { client.free(); } catch { /* best effort */ }
        }
      }
    }
    if (txidStr === null) {
      const lastErr = broadcastErrors.length > 0
        ? broadcastErrors[broadcastErrors.length - 1].err
        : new Error("no providers");
      throw new WalletError(
        ERROR_CODES.BROADCAST_FAILED,
        "Broadcast rejected by the network",
        lastErr
      );
    }
    touch();
    // Kick off a resync so the new outgoing tx shows up. Failures here are
    // non-fatal — the broadcast already succeeded.
    try {
      await syncWallet();
    } catch {
      // swallow
    }
    return { txid: txidStr };
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
    prepareSend,
    confirmSend,
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
