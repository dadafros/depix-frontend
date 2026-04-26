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

import { WalletError, ERROR_CODES, isWalletError } from "./wallet-errors.js";
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
  getUpdate,
  putUpdate,
  readMeta,
  writeMeta
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

// Liquid Esplora endpoint. The wallet's only upstream is our own
// depix-backend reverse proxy at /api/esplora. The proxy itself fans out
// server-side to Blockstream → liquid.network, so a single client-visible
// endpoint already gets two-tier upstream redundancy.
//
// Why no client-side fallback to Blockstream direct: when we listed it as
// a second provider, any time the proxy slowed under load or returned a
// transient 5xx, LWK fell through to Blockstream and the user's IP got
// rate-limited (429 cascade visible in the bug-reporter's network tab —
// 850+ direct blockstream.info requests in one cold-scan attempt, while
// the proxy was still healthy). Cleaner to error out and surface the
// retry CTA than to burn the user's per-IP quota on a public endpoint
// that wasn't designed for our request volume. If the proxy is down, no
// amount of client fallback rescues us — most wallet operations need it.
//
// Why proxy at all (the original code went direct-from-client): three
// problems made direct untenable for users with active wallets (~250+ txs):
//
//   1. LWK 0.16 retries 429s without backoff — observed ~3000 requests in
//      30 minutes for one sync attempt, hammering the same URL 8x with
//      429 responses. Burns the per-IP quota and false-positive trips our
//      timeout, locking the user out via exponential backoff.
//   2. Block headers and confirmed raw txs are immutable but the wallet
//      had no shared cache — every browser refetched them from scratch.
//      The proxy fronts them with Vercel-CDN-Cache-Control s-maxage=1y,
//      so warm requests are served from edge without invoking the
//      function or hitting upstream at all.
//   3. liquid.network was CORS-blocked in browsers. Either we drop it or
//      access it through a server-side intermediary (now done).
//
// The "cross-user cache hit to amortize" concern in the old comment was
// only true for scripthash queries (per-address, user-unique); block
// headers, raw txs, and merkle proofs are universal across users, and
// PIX deposit clustering produces high overlap on the address-list pages
// for confirmed history. Proxy-side cache pays back even at low DAU.
//
// Can be overridden with `esploraUrl` (single URL, legacy) or
// `esploraProviders` (array of {name, url}) for tests and alt networks.
const DEFAULT_PROVIDERS_MAINNET = Object.freeze([
  Object.freeze({ name: "depix-proxy", url: "https://depix-backend.vercel.app/api/esplora" })
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
      // The header-chip fingerprint cache is tied to this wallet's lifetime;
      // drop it together so a new wallet installation starts with no stale id.
      localStorage.removeItem("depix-wallet-identity");
    }
  } catch { /* private mode / disabled */ }
}

// LWK wraps Esplora fetch errors as a plain `Error` whose `message` contains
// the upstream status (e.g. "error response 429 Too Many Requests" on 0.16.x).
// We pattern-match on the stringified error because LWK does not expose a
// typed discriminator; a breaking upstream change would silently degrade
// this into the generic ESPLORA_UNAVAILABLE path, which is acceptable — the
// 60s backoff UX is a nicety, not a correctness guarantee.
//
// Discriminator: errors we synthesize with `code: "SYNC_TIMEOUT"` are NOT
// rate-limit signals even if their message happens to contain "rate limit"
// or "429" (avoids feedback loops where our own timeout text mis-fires the
// classifier). The runSingleScan timeout sets this code; everyone else
// must avoid that exact string code if they want their error treated as
// a rate-limit by this function.
function isRateLimitError(err) {
  // The SYNC_TIMEOUT discriminator is checked ONLY on the leaf (top-level)
  // error so a hypothetical future wrapper that pins code:"SYNC_TIMEOUT"
  // on a synthesized outer error cannot mask a genuine 429 buried in its
  // cause chain. Our own runSingleScan timeout sets the code at the leaf,
  // so this still classifies our timeouts correctly as not-rate-limit.
  if (err?.code === "SYNC_TIMEOUT") return false;
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
  syncTimeoutMs,
  coldStartTimeoutMs,
  coldStartIndex
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
      // Distinguishes from BIOMETRIC_REJECTED (user-cancel of the OS prompt).
      // Decrypt failure means the assertion succeeded and the PRF secret was
      // derived, but the wrapped key no longer unwraps the seed (stale wrap
      // after a credential reset, or in-flight corruption). The UI silently
      // falls back to PIN when this happens — see wallet-ui.js.
      throw new WalletError(
        ERROR_CODES.BIOMETRIC_DECRYPT_FAILED,
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
    // Rehydrate from the persisted Update chain. Each Update is keyed by
    // the Wollet's status() hash BEFORE its apply was performed; replay
    // walks the chain by recomputing status after every apply and looking
    // up the next link until the chain is exhausted. If the chain breaks
    // mid-replay we throw the partial state away and rebuild an empty
    // Wollet so the next sync runs a true cold-start fullScanToIndex(200)
    // — otherwise neverScanned()=false would route us through the warm
    // fullScan path that triggered the original gap-limit bug.
    if (!appliedCachedUpdate) {
      try {
        const result = await loadPersisted(wollet);
        if (result?.lastScanAt > 0) lastScanAt = result.lastScanAt;
        if (result?.complete === false) {
          try { wollet.free?.(); } catch { /* best effort */ }
          wollet = await restoreWollet(descriptorStr);
          try {
            const database = await db();
            const storeMod = await import("./wallet-store.js");
            await storeMod.clearAllUpdates(database);
          } catch { /* best effort */ }
        }
      } catch {
        // swallow — cached chain is best-effort.
      }
      appliedCachedUpdate = true;
    }
    return wollet;
  }

  // Replay the persisted chain into the Wollet. Mirrors the pattern from
  // RCasatta/liquid-web-wallet's `loadPersisted` (index.ts:3134-3155):
  // recompute the Wollet's status, look up the Update keyed by that
  // status, apply it, repeat until no entry matches the current status.
  // Returns the meta.lastScanAt timestamp so the caller can restore its
  // "synced N seconds ago" UI without an extra round-trip.
  async function loadPersisted(wolletLocal) {
    const database = await db();
    const meta = await readMeta(database);
    // Track visited keys so a degenerate chain (status cycle of any length,
    // self-referential link, or LWK quirk where status is invariant under a
    // delta) cannot loop forever. Stricter than a single-step prevStatus
    // guard, which only catches cycles of length 1.
    const visited = new Set();
    let complete = true;
    while (true) {
      const status = wolletLocal.status().toString();
      if (visited.has(status)) break;
      visited.add(status);
      const record = await getUpdate(database, status);
      if (!record?.updateBlob) break;
      const l = await lwk();
      const bytes = toUint8(record.updateBlob);
      const update = new l.Update(bytes);
      try {
        wolletLocal.applyUpdate(update);
      } catch {
        // Status mismatch — chain broken. Don't leave the Wollet in a
        // half-applied state where neverScanned()=false would cause the
        // next sync to use the warm fullScan path (which would re-trigger
        // the gap-limit-fura bug this PR was written to fix). Signal
        // incompleteness so the caller can rebuild a clean cold-start
        // Wollet.
        if (update.free) try { update.free(); } catch { /* best effort */ }
        complete = false;
        break;
      }
      if (update.free) try { update.free(); } catch { /* best effort */ }
    }
    return {
      lastScanAt: typeof meta?.lastScanAt === "number" ? meta.lastScanAt : 0,
      complete
    };
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

  // Build one EsploraClient for a specific provider.
  //
  // Concurrency choice depends on the upstream:
  //   - "depix-proxy" runs at concurrency=4. Our backend absorbs the burst
  //     with edge cache + server-side fallback, so parallelism translates
  //     directly into faster cold starts. ~4× wall-clock speedup observed
  //     in the reference implementation (liquidwebwallet.org also uses 4).
  //   - any other upstream (Blockstream direct, custom URLs from tests)
  //     stays at concurrency=1 to avoid burst-tripping public per-IP
  //     limits. The proxy is the only upstream we trust to handle bursts.
  //
  // Tests inject `esploraClientFactory` to fan out per-provider behavior.
  async function buildEsploraClient(l, net, provider) {
    if (typeof esploraClientFactory === "function") {
      return esploraClientFactory(l, net, provider);
    }
    // Concurrency comes off the provider record's `concurrency` field when
    // the operator opts in, so renaming or adding new bursty-tolerant
    // providers no longer requires touching this function. Falls back to
    // the legacy name-based keying for the existing depix-proxy default
    // record (which doesn't carry an explicit concurrency field today);
    // any other unconfigured provider stays at concurrency=1 to avoid
    // burst-tripping public per-IP limits.
    let concurrency;
    if (typeof provider?.concurrency === "number") {
      concurrency = provider.concurrency;
    } else if (provider?.name === "depix-proxy") {
      concurrency = 4;
    } else {
      concurrency = 1;
    }
    return new l.EsploraClient(net, provider.url, false, concurrency, false);
  }

  // Wall-clock guards on a single provider's scan. Two timeouts because
  // cold-start (first scan ever, against an empty Wollet) does dramatically
  // more work than a warm incremental sync:
  //
  //   - SYNC_TIMEOUT_MS (60s): warm incremental scan — LWK starts from the
  //     persisted cursor and only fetches new addresses + new block
  //     headers. Typically <5s through the proxy; 60s is a generous ceiling
  //     to absorb temporary upstream slowness without classifying it as a
  //     rate limit.
  //
  //   - COLD_START_TIMEOUT_MS (1800s = 30 min): first scan walks up to
  //     COLD_START_INDEX addresses on EACH chain (external + internal),
  //     plus a fullScan extension for gap-limit. For a heavy SideSwap-grade
  //     wallet (~250 txs distributed sparsely across 1000+ derivation
  //     indices), one cold scan can produce 1500-2000 HTTP round-trips and
  //     legitimately take 10-15 minutes through the proxy on first warm-up
  //     (when the edge cache is empty). The earlier 5-minute cap timed-out
  //     mid-scan and stranded users on partial state. 30 minutes is the
  //     comfort margin so the cold path runs once, completes, and the
  //     persisted chain pays back forever.
  //
  // Overridable via `syncTimeoutMs` / `coldStartTimeoutMs` so tests can
  // assert the timeout path deterministically without real-time waits.
  const SYNC_TIMEOUT_MS = typeof syncTimeoutMs === "number" ? syncTimeoutMs : 60_000;
  const COLD_START_TIMEOUT_MS = typeof coldStartTimeoutMs === "number"
    ? coldStartTimeoutMs
    : (typeof syncTimeoutMs === "number" ? syncTimeoutMs : 1_800_000);

  // Force scan up to AT LEAST this index on each derivation chain on cold
  // start, regardless of LWK's gap-limit (default 20). 1000 covers even
  // active wallets with sparse, non-contiguous derivation usage (e.g.
  // SideSwap users whose swap UI burns through addresses fast). After
  // fullScanToIndex(1000) we run a regular fullScan(w) so gap-limit=20
  // catches any tail past index 1000. The cost is ~2000 scripthash queries
  // (1000 × 2 chains) on cold start, but most empty-address responses are
  // small JSON ([]) and the proxy edge-caches them; the second run of the
  // same cold-start (different device, same wallet) hits cache for nearly
  // all of it.
  //
  // Why not lower (e.g. 500): the bug-reporter's wallet returned 113 txs
  // with COLD_START_INDEX=200 — strictly less than the 138 a plain
  // fullScan was finding before, indicating txs lived in a sparse band
  // somewhere past index 200. 1000 is generous enough that "we missed
  // some" stops being the most likely cause of any future support
  // ticket; if a wallet ever exceeds it, bump again — single constant.
  const COLD_START_INDEX = typeof coldStartIndex === "number" ? coldStartIndex : 1000;

  // Race a scan promise against a wall-clock timer. The synthetic timeout
  // error carries `code: "SYNC_TIMEOUT"` so isRateLimitError() doesn't
  // false-fire on the message text.
  async function runScanWithTimeout(scanFn, timeoutMs, kind) {
    let timer;
    try {
      return await Promise.race([
        scanFn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`${kind} timed out after ${timeoutMs}ms`);
            err.code = "SYNC_TIMEOUT";
            reject(err);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Drive a full scan attempt against one client and persist the
  // resulting Update(s).
  //
  // Cold start (Wollet.neverScanned() === true): TWO scans, each
  // independently persisted. The first is fullScanToIndex(w, N), which
  // walks every derivation index 0..N regardless of LWK's gap-limit (so
  // a wallet with sparse usage and >20-address unused gaps before N is
  // discovered fully). The second is plain fullScan(w), which extends
  // past N with the standard gap_limit=20 — catching any tail txs that
  // live above N. Without the second scan, a tx at derivation index
  // N+5 would be missed (fullScanToIndex doesn't apply gap-limit logic
  // past its target index). Persisting BOTH means the chain captures
  // pre-N coverage even if step 2 fails midway.
  //
  // Warm sync: just fullScan(w) from the persisted cursor.
  //
  // Failure semantics: if step 1 succeeds and persists, step 2 failing
  // is acceptable — neverScanned() will return false on the next
  // attempt because step 1 was applied, so we'll resume in the warm
  // path. Any failure throws so the provider-fallback loop can advance.
  async function runProviderAttempt(client, w) {
    if (w.neverScanned()) {
      const u1 = await runScanWithTimeout(
        () => client.fullScanToIndex(w, COLD_START_INDEX),
        COLD_START_TIMEOUT_MS,
        "fullScanToIndex"
      );
      await persistScan(w, u1);
      const u2 = await runScanWithTimeout(
        () => client.fullScan(w),
        SYNC_TIMEOUT_MS,
        "fullScan"
      );
      return await persistScan(w, u2);
    }
    const u = await runScanWithTimeout(
      () => client.fullScan(w),
      SYNC_TIMEOUT_MS,
      "fullScan"
    );
    return await persistScan(w, u);
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
    // semantics — still guarded by the per-step timeout inside
    // runProviderAttempt.
    if (providers.length === 0) {
      const client = await net.defaultEsploraClient();
      try {
        return await runProviderAttempt(client, w);
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
        const result = await runProviderAttempt(client, w);
        lastGoodProviderIndex = idx;
        syncsSinceLastRediscovery = forceRediscovery ? 0 : syncsSinceLastRediscovery + 1;
        return result;
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
      // The chain link's key is the Wollet status BEFORE applyUpdate —
      // that's what loadPersisted will look up against a freshly-built
      // empty Wollet on the next cold start. Capture it before mutating.
      let statusBefore = null;
      try { statusBefore = w.status().toString(); } catch { /* defensive */ }

      // Whether the Update is a meaningful payload (txs / scripts / spent
      // outpoints) or just a tip-bump. liquidwebwallet skips persistence on
      // tip-only Updates because they bloat the chain without adding
      // restorable state — the tip is recoverable from the next non-tip
      // scan. We mirror that to keep the IDB chain bounded.
      // Default to TRUE on read failure (fail-closed): better to skip
      // persistence for one Update than to bloat the chain with onlyTip
      // entries we said we'd skip if a future LWK quirk makes onlyTip()
      // throw on edge cases.
      let onlyTip = true;
      try { onlyTip = typeof update.onlyTip === "function" ? update.onlyTip() : false; } catch { /* defensive — keep onlyTip=true */ }

      w.applyUpdate(update);

      if (!onlyTip && statusBefore) {
        try {
          // Prune drops witness data the wallet doesn't need for balance/
          // history rendering — small win on storage, big win across many
          // scans for an active wallet.
          if (typeof update.prune === "function") {
            try { update.prune(w); } catch { /* best effort */ }
          }
          const bytes = update.serialize();
          const database = await db();
          await putUpdate(database, statusBefore, bytes);
          await writeMeta(database, { lastScanAt: scanAt, lastSuccessAt: scanAt });
        } catch (persistErr) {
          // Persistence failed — could be QuotaExceeded, IDB abort, serialize
          // crash, or putUpdate validation rejection. Record a neutral
          // failure timestamp + the specific error name so dashboards can
          // distinguish quota issues from other failures without splitting
          // the catch. The scan still applied to the in-memory Wollet; the
          // UI keeps working until reload.
          try {
            const database = await db();
            const errName = persistErr?.name ?? null;
            await writeMeta(database, {
              lastScanAt: scanAt,
              lastPersistFailedAt: scanAt,
              lastPersistErrorName: errName,
              quotaExceeded: errName === "QuotaExceededError"
            });
          } catch { /* best effort */ }
        }
      } else {
        // Tip-only or status capture failed — just bump the meta clock.
        try {
          const database = await db();
          await writeMeta(database, { lastScanAt: scanAt, lastSuccessAt: scanAt });
        } catch { /* best effort */ }
      }

      if (update.free) {
        try { update.free(); } catch { /* best effort */ }
      }
    } else {
      // No Update returned (LWK signals "no change since last scan") —
      // bump the meta clock and remember a successful scan completed so the
      // next sync uses the cheap warm fullScan path even on an empty wallet
      // (which would otherwise re-pay the COLD_START_INDEX cost forever).
      try {
        const database = await db();
        await writeMeta(database, { lastScanAt: scanAt, lastSuccessAt: scanAt });
      } catch { /* best effort */ }
    }
    lastScanAt = scanAt;
    return { lastScanAt, changed: Boolean(update) };
  }

  function getLastScanAt() {
    return lastScanAt;
  }

  // True when the wallet's view-only Wollet has never received an applied
  // update — meaning the next sync will be a (slow) cold-start scan. The UI
  // uses this to choose between the short "Sincronizando…" copy and the
  // longer "Primeira sincronização (pode levar alguns minutos)" copy that
  // sets user expectation correctly.
  async function isFreshScan() {
    try {
      const w = await ensureViewWollet();
      return typeof w?.neverScanned === "function" ? w.neverScanned() : true;
    } catch {
      return true;
    }
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
    // Snapshot whether a biometric credential was enrolled BEFORE the IDB is
    // destroyed. The UI uses this to surface a one-time hint about the
    // OS-level passkey that we cannot delete from JS; users who never
    // enrolled never see the hint.
    const record = await readCredentials(database);
    const hadBiometric = record?.credentialId != null;
    zeroInMemory();
    // Close the handle and invalidate the cached promise BEFORE destroying;
    // deleteDatabase blocks as long as any connection is open.
    dbPromise = null;
    database.close();
    await destroyDatabase(indexedDbImpl);
    clearWalletExistsFlag();
    return { hadBiometric };
  }

  // Updates the biometric enrollment after the wallet was created (e.g. user
  // skipped it and later enables it from settings, or toggled it off and
  // back on). When a soft-disabled passkey is still on the device (left in
  // place by removeBiometric so we can reuse it), this re-derives the PRF
  // secret against the existing credential and wraps the seed under it
  // again — no new OS-level passkey is created. Falls through to a fresh
  // enrollment only when the existing passkey has been deleted from OS
  // settings; user-cancellation of the reuse prompt is rethrown so the
  // identifiers are not destroyed.
  async function addBiometric(pin) {
    const mnemonicStr = await exportMnemonic(pin);
    const database = await db();
    const record = await readCredentials(database);

    // Reuse path: passkey + salt are still present, only the wrapped seed
    // was cleared by removeBiometric. Re-authenticate, re-wrap.
    if (record?.credentialId && record?.prfSalt && record.wrappedSeedKey == null) {
      try {
        const prfSecret = await derivePrfSecret({
          credentialId: record.credentialId,
          prfSalt: record.prfSalt,
          credentialsImpl
        });
        const prfKey = await importPrfAsAesKey(prfSecret, cryptoImpl);
        const wrappedIv = randomIv(cryptoImpl);
        const wrappedCt = await encryptSeed(mnemonicStr, prfKey, wrappedIv, cryptoImpl);
        const wrappedSeedKey = new Uint8Array(wrappedIv.length + wrappedCt.length);
        wrappedSeedKey.set(wrappedIv, 0);
        wrappedSeedKey.set(wrappedCt, wrappedIv.length);
        await patchCredentials(database, { wrappedSeedKey });
        return;
      } catch (err) {
        // User cancelled the OS prompt: don't destroy their identifiers.
        // They can retry; the soft-disabled state stays intact.
        if (isWalletError(err, ERROR_CODES.BIOMETRIC_REJECTED)) throw err;
        // Only treat the credential as gone when the platform explicitly
        // says so (InvalidStateError ⇒ unknown credential). Other failures
        // (transient biometric hardware hiccup, rpId mismatch, momentary OS
        // error) are rethrown so the user retries against the existing
        // passkey instead of creating a duplicate via fresh enroll.
        if (err?.cause?.name !== "InvalidStateError") throw err;
        await patchCredentials(database, { credentialId: null, prfSalt: null });
      }
    }

    const biometric = await enrollBiometricForSeed(mnemonicStr);
    await patchCredentials(database, {
      credentialId: biometric.credentialId,
      prfSalt: biometric.prfSalt,
      wrappedSeedKey: biometric.wrappedSeedKey
    });
  }

  // Soft-disable: clears only the wrapped seed key. The credentialId and
  // prfSalt are intentionally preserved so a subsequent addBiometric() can
  // re-derive the PRF secret from the existing OS passkey instead of
  // creating a duplicate. hasBiometric() still returns false (it requires
  // all three fields via isPrfCredential).
  async function removeBiometric() {
    const database = await db();
    await patchCredentials(database, {
      wrappedSeedKey: null
    });
  }

  // Hard-clear escape hatch for the iOS-deleted-passkey loop: when a user
  // removes the DePix passkey from Settings → Senhas (or Android equivalent),
  // the WebAuthn spec requires the platform to respond with NotAllowedError
  // after the timeout — indistinguishable from user-cancel — so the reuse
  // path in addBiometric() preserves identifiers and the user is stuck in a
  // 60s loop with no in-app recovery.
  //
  // resetBiometric is the explicit recovery affordance. PIN-gated to prevent
  // accidental presses; clears credentialId + prfSalt + wrappedSeedKey so
  // the next addBiometric() falls through to the fresh-enroll branch and
  // calls credentials.create(), producing a brand-new OS passkey. The
  // previous OS passkey, if it still exists, becomes orphan in the device's
  // passkey list — UI surfaces the same "remove from Settings" hint as wipe.
  //
  // Returns `{ hadBiometric }` mirroring wipeWallet, so the UI can branch
  // identically on whether to show the orphan-passkey hint modal.
  async function resetBiometric(pin) {
    // PIN check via exportMnemonic — same gate wipeWallet uses. A wrong PIN
    // throws WRONG_PIN before we touch IDB; an exhausted-attempt path may
    // throw WALLET_WIPED, which already destroyed the wallet.
    await exportMnemonic(pin);
    const database = await db();
    const record = await readCredentials(database);
    const hadBiometric = record?.credentialId != null;
    await patchCredentials(database, {
      credentialId: null,
      prfSalt: null,
      wrappedSeedKey: null
    });
    return { hadBiometric };
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
    // LWK's TxBuilder is a CONSUMING builder — every method (feeRate,
    // drainLbtcWallet, drainLbtcTo, addLbtcRecipient, addRecipient) calls
    // `this.__destroy_into_raw()` in the wasm-bindgen layer and returns a
    // fresh TxBuilder instance. Ignoring the return value leaves the JS
    // wrapper with __wbg_ptr=0, and the next call throws "null pointer
    // passed to rust". Reassign from every chained call.
    let builder = new l.TxBuilder(net);
    if (typeof feeRate === "number" && Number.isFinite(feeRate) && feeRate > 0) {
      builder = builder.feeRate(feeRate);
    }
    if (sendAll) {
      builder = builder.drainLbtcWallet();
      builder = builder.drainLbtcTo(addr);
    } else if (resolved === ASSETS.LBTC) {
      builder = builder.addLbtcRecipient(addr, amount);
    } else {
      const assetId = new l.AssetId(resolved.id);
      builder = builder.addRecipient(addr, amount, assetId);
    }
    let pset;
    try {
      pset = builder.finish(w);
    } catch (err) {
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
    // Fire-and-forget the resync so the new outgoing tx eventually appears
    // in the history view. Awaiting here blocks the success screen for
    // ~20-30s (full gap-limit re-scan), which looks indistinguishable from
    // a hang to the user even though the tx is already in the mempool.
    // The broadcast already succeeded — return the txid immediately and
    // let the background sync finish whenever it finishes.
    void syncWallet().catch(() => { /* best effort; the 30s timer will retry */ });
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
    isFreshScan,
    getDescriptor,
    prepareSend,
    confirmSend,
    exportMnemonic,
    wipeWallet,
    addBiometric,
    removeBiometric,
    resetBiometric,
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
