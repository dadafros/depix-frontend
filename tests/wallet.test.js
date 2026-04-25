import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";
import { BIP39_WORDLIST } from "../wallet/bip39-wordlist.js";

// Build a stateful credentials mock that tracks how many times create/get
// were invoked. `failGet` controls the next get() call's behavior:
//   - false      → returns the same PRF bytes on every call (reuse path).
//   - "cancel"   → throws NotAllowedError (user-cancel).
//   - "missing"  → throws InvalidStateError (passkey deleted from device).
function makeBiometricCredentialsMock() {
  const PRF_BYTES = new Uint8Array(32).fill(7);
  const RAW_ID = new Uint8Array([0x42, 0x43, 0x44, 0x45]);
  let failGetMode = false;
  const create = vi.fn(async () => ({
    rawId: RAW_ID,
    getClientExtensionResults: () => ({
      prf: { results: { first: PRF_BYTES } }
    })
  }));
  const get = vi.fn(async () => {
    if (failGetMode === "cancel") {
      throw new DOMException("user canceled", "NotAllowedError");
    }
    if (failGetMode === "missing") {
      throw new DOMException("unknown credential", "InvalidStateError");
    }
    return {
      getClientExtensionResults: () => ({
        prf: { results: { first: PRF_BYTES } }
      })
    };
  });
  return {
    create,
    get,
    setFailGet: mode => { failGetMode = mode; }
  };
}

// Real BIP39 checksum validation — matches the semantics of LWK's Mnemonic
// constructor so unit tests can distinguish word-count errors from
// bad-checksum errors (the 1-in-16 false-positive scenario the fingerprint
// feature is designed to defend against). 12 words = 128 bits entropy + 4
// bits checksum; the checksum is the top 4 bits of SHA-256(entropy).
function verifyBip39Checksum(words) {
  let bits = "";
  for (const w of words) {
    const idx = BIP39_WORDLIST.indexOf(w);
    if (idx < 0) return false;
    bits += idx.toString(2).padStart(11, "0");
  }
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    entropy[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
  }
  const expected = createHash("sha256").update(entropy).digest()[0] >> 4;
  const actual = parseInt(bits.slice(128), 2);
  return expected === actual;
}

// Given 16 deterministic entropy bytes, produce a valid 12-word BIP39
// mnemonic. Used by fromRandom() so generated seeds pass checksum.
function entropyToMnemonicWords(entropy) {
  const checksum = createHash("sha256").update(entropy).digest()[0] >> 4;
  let bits = "";
  for (const byte of entropy) bits += byte.toString(2).padStart(8, "0");
  bits += checksum.toString(2).padStart(4, "0");
  const out = [];
  for (let i = 0; i < 12; i++) {
    const idx = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
    out.push(BIP39_WORDLIST[idx]);
  }
  return out;
}

// LWK is too heavy to load in jsdom. The wallet module delegates all crypto-
// currency-specific work to the lwk namespace returned by `loadLwk`, so we
// inject a fake namespace via the `lwkLoader` dependency — no vi.mock needed.
function makeFakeLwk() {
  // Closure-scoped counter so each call to `Mnemonic.fromRandom` returns a
  // distinct mnemonic — the real LWK entropy is random, tests should not rely
  // on a specific seed value. Incrementing from the wordlist keeps each
  // token a valid BIP39 word.
  let fromRandomCounter = 0;
  class Mnemonic {
    constructor(str) {
      const words = String(str).trim().split(/\s+/);
      if (words.length !== 12) {
        throw new Error("fake lwk: mnemonic must be 12 words");
      }
      // Match LWK: any of (wrong word count | word not in BIP39 wordlist |
      // bad checksum) produces the same failure surface. The unit under
      // test folds all three into INVALID_MNEMONIC.
      if (!verifyBip39Checksum(words)) {
        throw new Error("fake lwk: BIP39 checksum or wordlist validation failed");
      }
      this._str = words.join(" ");
    }
    toString() { return this._str; }
    static fromRandom(_bits) {
      fromRandomCounter++;
      // Deterministic entropy so each call is reproducible; real LWK uses
      // real randomness but tests need stable output for assertions.
      const entropy = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        entropy[i] = (fromRandomCounter * 31 + i * 7) & 0xff;
      }
      const words = entropyToMnemonicWords(entropy);
      return new Mnemonic(words.join(" "));
    }
  }

  class Signer {
    constructor(mnemonic, _network) {
      this._mnemonic = mnemonic.toString();
    }
    wpkhSlip77Descriptor() {
      // Deterministic descriptor derived from the mnemonic string so
      // restoreWallet's descriptor-mismatch check has something real to bite
      // on when the test wants a divergent seed.
      const str = `ct(slip77(${this._mnemonic.replace(/\s+/g, "_")}))`;
      return new WolletDescriptor(str);
    }
    free() {}
  }

  class WolletDescriptor {
    constructor(str) { this._str = str; }
    toString() { return this._str; }
  }

  class Address {
    constructor(str) { this._str = str; }
    toString() { return this._str; }
  }

  class AddressResult {
    constructor(str) { this._addr = new Address(str); }
    address() { return this._addr; }
  }

  class Wollet {
    constructor(_network, descriptor) {
      this._descriptor = descriptor.toString();
    }
    address(index) {
      // Not a real derivation; the test doesn't care, it just needs a string.
      return new AddressResult(`lq1fake-${this._descriptor}-${index ?? 0}`);
    }
    balance() {
      return { lbtc: 0, assets: {} };
    }
    transactions() {
      return [];
    }
    free() {}
  }

  const Network = {
    mainnet() { return { _kind: "mainnet" }; },
    testnet() { return { _kind: "testnet" }; },
    regtestDefault() { return { _kind: "regtest" }; }
  };

  return {
    Mnemonic,
    Signer,
    Wollet,
    WolletDescriptor,
    Network
  };
}

function makeModule({ clock, credentialsImpl, idbFactory: existingIdb } = {}) {
  const fakeLwk = makeFakeLwk();
  const idbFactory = existingIdb ?? new IDBFactory();
  return {
    wallet: createWalletModule({
      indexedDbImpl: idbFactory,
      cryptoImpl: webcrypto,
      credentialsImpl,
      lwkLoader: async () => fakeLwk,
      clock: clock ?? (() => Date.now())
    }),
    fakeLwk,
    idbFactory
  };
}

const STRONG_PIN = "702486";
const SECOND_PIN = "358914";

describe("wallet.createWallet", () => {
  it("generates a mnemonic, persists, and unlocks", async () => {
    const { wallet } = makeModule();
    expect(await wallet.hasWallet()).toBe(false);
    const res = await wallet.createWallet({ pin: STRONG_PIN });
    expect(res.mnemonic.split(" ")).toHaveLength(12);
    expect(res.descriptor).toMatch(/^ct\(/);
    expect(res.hasBiometric).toBe(false);
    expect(await wallet.hasWallet()).toBe(true);
    expect(wallet.isUnlocked()).toBe(true);
  });

  it("refuses to overwrite an existing wallet", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    try {
      await wallet.createWallet({ pin: STRONG_PIN });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WALLET_ALREADY_EXISTS);
    }
  });

  it("rejects weak pins", async () => {
    const { wallet } = makeModule();
    try {
      await wallet.createWallet({ pin: "000000" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WEAK_PIN);
    }
  });
}, 60_000);

describe("wallet.unlockWithPin", () => {
  it("counter progression 1→2→3→4→5→WALLET_WIPED with clock advance", async () => {
    let t = 1_000_000;
    const clock = () => t;
    const { wallet } = makeModule({ clock });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();

    // Attempts 1 and 2: plain WRONG_PIN, no rate-limit yet.
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    // Attempt 3: WRONG_PIN AND arms the rate-limit window for the next call.
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    // Attempt 4 inside the 10s rate-limit window: PIN_RATE_LIMITED, counter untouched.
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.PIN_RATE_LIMITED
    });
    // Advance past the 10s window → counter bumps to 4, WRONG_PIN surfaces.
    t += 15_000;
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    // Advance again → counter hits 5 → WALLET_WIPED, sensitive credentials gone.
    t += 15_000;
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WALLET_WIPED
    });
    expect(await wallet.hasWallet()).toBe(false);
  }, 180_000);

  it("correct PIN resets the counter and unlocks", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    // One wrong, then right.
    await expect(wallet.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    const res = await wallet.unlockWithPin(STRONG_PIN);
    expect(res.descriptor).toMatch(/^ct\(/);
    expect(wallet.isUnlocked()).toBe(true);
  }, 120_000);

  it("returns WALLET_NOT_FOUND before any wallet is created", async () => {
    const { wallet } = makeModule();
    await expect(wallet.unlockWithPin(STRONG_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WALLET_NOT_FOUND
    });
  });
});

describe("view-only accessors", () => {
  it("work on a fresh module backed by the same IDB (simulated reload)", async () => {
    const idbFactory = new IDBFactory();
    const fakeLwk = makeFakeLwk();
    const first = createWalletModule({
      indexedDbImpl: idbFactory,
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk
    });
    await first.createWallet({ pin: STRONG_PIN });
    first.lock();
    // Simulate a page reload: drop the first module, build a fresh one
    // backed by the SAME IDBFactory. No unlock — view-only must work off
    // the plaintext descriptor in IndexedDB.
    const second = createWalletModule({
      indexedDbImpl: idbFactory,
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk
    });
    expect(second.isUnlocked()).toBe(false);
    const address = await second.getReceiveAddress();
    expect(address).toMatch(/^lq1fake-/);
    const balances = await second.getBalances();
    expect(balances).toBeDefined();
    const txs = await second.listTransactions();
    expect(Array.isArray(txs)).toBe(true);
  }, 60_000);
});

describe("auto-lock", () => {
  it("locks the signer after AUTO_LOCK_MINUTES of inactivity", async () => {
    let t = 1_000_000;
    const clock = () => t;
    const { wallet } = makeModule({ clock });
    await wallet.createWallet({ pin: STRONG_PIN });
    expect(wallet.isUnlocked()).toBe(true);
    // Advance past the 15-minute idle threshold.
    t += 16 * 60 * 1000;
    expect(wallet.isUnlocked()).toBe(false);
  }, 60_000);
});

describe("restoreWallet", () => {
  it("accepts a mnemonic and reconstructs the descriptor", async () => {
    const { wallet } = makeModule();
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const res = await wallet.restoreWallet({ mnemonic, pin: STRONG_PIN });
    expect(res.descriptor).toMatch(/^ct\(/);
    expect(await wallet.hasWallet()).toBe(true);
  }, 60_000);

  it("rejects an invalid mnemonic", async () => {
    const { wallet } = makeModule();
    try {
      await wallet.restoreWallet({ mnemonic: "not twelve words", pin: STRONG_PIN });
      throw new Error("expected throw");
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_MNEMONIC);
    }
  });
});

describe("exportMnemonic + wipeWallet", () => {
  it("export returns the original mnemonic with the right PIN", async () => {
    const { wallet } = makeModule();
    const { mnemonic } = await wallet.createWallet({ pin: STRONG_PIN });
    const back = await wallet.exportMnemonic(STRONG_PIN);
    expect(back).toBe(mnemonic);
  }, 60_000);

  it("wipeWallet clears everything behind a PIN gate", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    await wallet.wipeWallet(STRONG_PIN);
    expect(await wallet.hasWallet()).toBe(false);
  }, 60_000);

  it("wipeWallet with the wrong PIN refuses", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    await expect(wallet.wipeWallet(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    expect(await wallet.hasWallet()).toBe(true);
  }, 60_000);
});

describe("wallet.generateMnemonic", () => {
  it("returns a string of 12 space-separated tokens", async () => {
    const { wallet } = makeModule();
    const mnemonic = await wallet.generateMnemonic();
    expect(typeof mnemonic).toBe("string");
    const tokens = mnemonic.split(" ");
    expect(tokens).toHaveLength(12);
    for (const t of tokens) {
      expect(t).toMatch(/^[a-z]+$/);
    }
  });

  it("every token is in the BIP39 wordlist", async () => {
    const { wallet } = makeModule();
    const mnemonic = await wallet.generateMnemonic();
    for (const token of mnemonic.split(" ")) {
      expect(BIP39_WORDLIST).toContain(token);
    }
  });

  it("repeated calls return different mnemonics (randomness sanity)", async () => {
    const { wallet } = makeModule();
    const a = await wallet.generateMnemonic();
    const b = await wallet.generateMnemonic();
    const c = await wallet.generateMnemonic();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("does NOT persist anything — hasWallet() stays false", async () => {
    const { wallet } = makeModule();
    await wallet.generateMnemonic();
    await wallet.generateMnemonic();
    expect(await wallet.hasWallet()).toBe(false);
  });
});

describe("wallet.validateMnemonic", () => {
  it("resolves for a 12-word mnemonic the fake LWK accepts", async () => {
    const { wallet } = makeModule();
    const valid = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(wallet.validateMnemonic(valid)).resolves.toBeUndefined();
  });

  it("throws INVALID_MNEMONIC on non-string / empty input", async () => {
    const { wallet } = makeModule();
    await expect(wallet.validateMnemonic("")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
    await expect(wallet.validateMnemonic("   ")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
    await expect(wallet.validateMnemonic(null)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
  });

  it("throws INVALID_MNEMONIC when LWK rejects the word list", async () => {
    // Fake LWK's Mnemonic constructor requires exactly 12 words; any other
    // count should surface as INVALID_MNEMONIC (wraps the raw error).
    const { wallet } = makeModule();
    await expect(wallet.validateMnemonic("one two three")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
  });

  it("does NOT persist anything — hasWallet() stays false after valid input", async () => {
    const { wallet } = makeModule();
    const valid = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await wallet.validateMnemonic(valid);
    expect(await wallet.hasWallet()).toBe(false);
  });
});

describe("wallet.deriveDescriptor", () => {
  const VALID = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("returns a non-empty CT descriptor string for a valid mnemonic", async () => {
    const { wallet } = makeModule();
    const descriptor = await wallet.deriveDescriptor(VALID);
    expect(typeof descriptor).toBe("string");
    expect(descriptor.length).toBeGreaterThan(0);
    expect(descriptor).toMatch(/^ct\(/);
  });

  it("is deterministic — same mnemonic produces the same descriptor", async () => {
    const { wallet } = makeModule();
    const a = await wallet.deriveDescriptor(VALID);
    const b = await wallet.deriveDescriptor(VALID);
    expect(a).toBe(b);
  });

  it("different mnemonics produce different descriptors", async () => {
    const { wallet } = makeModule();
    const other = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const a = await wallet.deriveDescriptor(VALID);
    const b = await wallet.deriveDescriptor(other);
    expect(a).not.toBe(b);
  });

  it("throws INVALID_MNEMONIC on empty/whitespace/non-string input", async () => {
    const { wallet } = makeModule();
    await expect(wallet.deriveDescriptor("")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
    await expect(wallet.deriveDescriptor("   ")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
    await expect(wallet.deriveDescriptor(null)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
  });

  it("throws INVALID_MNEMONIC when LWK rejects the word count", async () => {
    const { wallet } = makeModule();
    await expect(wallet.deriveDescriptor("one two three")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
  });

  // The 1-in-16 false-positive scenario this whole sub-fase is designed for:
  // 12 valid BIP39 words whose checksum fails. Pins down that LWK surfaces
  // INVALID_MNEMONIC on the checksum branch (not just word-count validation)
  // — insurance against an LWK taxonomy change silently slipping past the
  // restore flow.
  it("throws INVALID_MNEMONIC when 12 valid words fail the checksum", async () => {
    const { wallet } = makeModule();
    // All 12 words are valid BIP39 entries, but the checksum for 12×"abandon"
    // requires "about" at the end — so this combination is rejected.
    const badChecksum = "abandon ".repeat(12).trim();
    await expect(wallet.deriveDescriptor(badChecksum)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MNEMONIC
    });
  });

  it("does NOT persist anything — hasWallet() stays false", async () => {
    const { wallet } = makeModule();
    await wallet.deriveDescriptor(VALID);
    await wallet.deriveDescriptor(VALID);
    expect(await wallet.hasWallet()).toBe(false);
  });

  it("does NOT affect unlock state — isUnlocked() stays false", async () => {
    const { wallet } = makeModule();
    expect(wallet.isUnlocked()).toBe(false);
    await wallet.deriveDescriptor(VALID);
    expect(wallet.isUnlocked()).toBe(false);
  });
});

describe("public API surface", () => {
  it("exposes only the documented methods, is frozen, and rejects mutation", async () => {
    const { wallet } = makeModule();
    expect(Object.isFrozen(wallet)).toBe(true);
    const methods = [
      "hasWallet",
      "hasBiometric",
      "biometricSupported",
      "isUnlocked",
      "generateMnemonic",
      "validateMnemonic",
      "deriveDescriptor",
      "createWallet",
      "restoreWallet",
      "unlock",
      "unlockWithPin",
      "unlockWithBiometric",
      "lock",
      "getReceiveAddress",
      "getBalances",
      "listTransactions",
      "getDescriptor",
      "getLastScanAt",
      "syncWallet",
      "prepareSend",
      "confirmSend",
      "exportMnemonic",
      "wipeWallet",
      "addBiometric",
      "removeBiometric",
      "resetBiometric",
      "touch",
      "_zeroInMemory"
    ];
    for (const m of methods) {
      expect(typeof wallet[m]).toBe("function");
    }
    // Exact surface — no extra methods creep in.
    expect(Object.keys(wallet).sort()).toEqual([...methods].sort());
    // Freeze is load-bearing: mutation must throw in ES-module strict mode.
    expect(() => { wallet.unlockWithPin = () => null; }).toThrow(TypeError);
    expect(() => { wallet.newMethod = () => null; }).toThrow(TypeError);
  });
});

describe("failedPinAttempts persistence across module instances", () => {
  it("rate-limit state survives a simulated page reload", async () => {
    // Shared IDBFactory simulates the browser's IndexedDB sticking around
    // across a reload. A fresh createWalletModule in a new session must
    // read the counter from IDB, not from the (dropped) closure.
    let t = 1_000_000;
    const clock = () => t;
    const sharedIdb = new IDBFactory();

    // Session A: create wallet, lock, burn 3 wrong PINs (attempt 3 arms
    // the rate-limit window).
    const { wallet: walletA } = makeModule({ clock, idbFactory: sharedIdb });
    await walletA.createWallet({ pin: STRONG_PIN });
    walletA.lock();
    await expect(walletA.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    await expect(walletA.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
    await expect(walletA.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });

    // Drop session A; spin up session B backed by the SAME IDBFactory.
    // NB: the rate-limit *window* (`rateLimitUntil`) is closure-only and
    // ephemeral per session by design — only the counter persists. So on
    // session B we prove persistence via the counter itself: two more wrong
    // attempts take us to 5 → WALLET_WIPED. If the counter had leaked back
    // to 0 in B, it'd take 5 attempts instead of 2.
    const { wallet: walletB } = makeModule({ clock, idbFactory: sharedIdb });
    expect(walletB.isUnlocked()).toBe(false);

    // Attempt 4: WRONG_PIN (counter 3 → 4). Error message carries the
    // remaining count, which proves the counter came from IDB and not from
    // a fresh closure.
    let err4;
    try { await walletB.unlockWithPin(SECOND_PIN); } catch (e) { err4 = e; }
    expect(err4).toBeInstanceOf(WalletError);
    expect(err4.code).toBe(ERROR_CODES.WRONG_PIN);
    expect(err4.message).toMatch(/1 attempts remaining/);

    // Attempt 5: WALLET_WIPED (only reachable in 2 session-B attempts if
    // the session-A counter persisted).
    t += 15_000; // step past session B's own rate-limit window
    await expect(walletB.unlockWithPin(SECOND_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.WALLET_WIPED
    });
    expect(await walletB.hasWallet()).toBe(false);
  }, 180_000);
});

describe("biometric enrollment lifecycle", () => {
  // Node 22 ships a built-in navigator on globalThis as a getter-only
  // property. Stub it via Object.defineProperty so wallet-biometric.js's
  // hasWebAuthn() returns true, and unstub on suite teardown to keep
  // other suites' state clean. PublicKeyCredential is not built-in, so a
  // plain assignment is fine.
  let originalNavigatorDescriptor;
  let originalPKC;
  beforeAll(() => {
    originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    originalPKC = globalThis.PublicKeyCredential;
    Object.defineProperty(globalThis, "navigator", {
      value: { credentials: {} },
      configurable: true,
      writable: true
    });
    globalThis.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true
    };
  });
  afterAll(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    globalThis.PublicKeyCredential = originalPKC;
  });

  it("toggle cycle reuses the existing passkey instead of creating a duplicate", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
    expect(cred.create).toHaveBeenCalledTimes(1);
    expect(await wallet.hasBiometric()).toBe(true);

    // Soft-disable.
    await wallet.removeBiometric();
    expect(await wallet.hasBiometric()).toBe(false);
    expect(cred.create).toHaveBeenCalledTimes(1); // still 1 — no new passkey

    // Re-enable. The reuse path calls get() against the existing passkey
    // and re-wraps the seed under the same PRF secret. No second create().
    await wallet.addBiometric(STRONG_PIN);
    expect(cred.get).toHaveBeenCalledTimes(1);
    expect(cred.create).toHaveBeenCalledTimes(1);
    expect(await wallet.hasBiometric()).toBe(true);

    // Unlock proves the rewrap actually works end-to-end.
    wallet.lock();
    cred.get.mockClear();
    const unlock = await wallet.unlockWithBiometric();
    expect(unlock.descriptor).toMatch(/^ct\(/);
    expect(cred.get).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("falls through to a fresh enrollment when the passkey was deleted from the OS", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
    await wallet.removeBiometric();

    cred.setFailGet("missing");
    await wallet.addBiometric(STRONG_PIN);
    cred.setFailGet(false);
    expect(cred.get).toHaveBeenCalledTimes(1);  // attempted reuse
    expect(cred.create).toHaveBeenCalledTimes(2); // fresh enroll after fall-through
    expect(await wallet.hasBiometric()).toBe(true);

    // The new credential works for unlock.
    wallet.lock();
    const unlock = await wallet.unlockWithBiometric();
    expect(unlock.descriptor).toMatch(/^ct\(/);
  }, 60_000);

  it("user-cancel during reuse rethrows BIOMETRIC_REJECTED and preserves identifiers", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
    await wallet.removeBiometric();

    cred.setFailGet("cancel");
    await expect(wallet.addBiometric(STRONG_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.BIOMETRIC_REJECTED
    });
    expect(cred.create).toHaveBeenCalledTimes(1); // NOT bumped — no new passkey
    expect(await wallet.hasBiometric()).toBe(false);

    // Identifiers must still be in IDB so a retry hits the reuse path.
    cred.setFailGet(false);
    cred.get.mockClear();
    await wallet.addBiometric(STRONG_PIN);
    expect(cred.get).toHaveBeenCalledTimes(1);
    expect(cred.create).toHaveBeenCalledTimes(1); // still no second create
    expect(await wallet.hasBiometric()).toBe(true);
  }, 60_000);

  // Documents the iOS-deleted-passkey gap: WebAuthn spec mandates the
  // platform respond with NotAllowedError (after the timeout) when
  // allowCredentials references a credential the authenticator no longer
  // knows — for privacy, so a relying party can't probe credential
  // existence. addBiometric currently treats this as user-cancel and
  // preserves identifiers, so the user is stuck unless they wipe. This
  // test pins that behavior so future changes that try to recover from
  // this scenario also update the test.
  it("deleted-passkey on iOS surfaces as NotAllowedError → identifiers preserved (known gap)", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
    await wallet.removeBiometric();

    // iOS reports a deleted passkey as NotAllowedError after the timeout,
    // indistinguishable from a real user-cancel — see WebAuthn spec.
    cred.setFailGet("cancel");
    await expect(wallet.addBiometric(STRONG_PIN)).rejects.toMatchObject({
      code: ERROR_CODES.BIOMETRIC_REJECTED
    });
    expect(cred.create).toHaveBeenCalledTimes(1); // no fresh enroll
    expect(await wallet.hasBiometric()).toBe(false);
  }, 60_000);

  it("addBiometric creates a fresh passkey when none was ever enrolled", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN }); // no biometric on create
    expect(cred.create).toHaveBeenCalledTimes(0);

    await wallet.addBiometric(STRONG_PIN);
    expect(cred.create).toHaveBeenCalledTimes(1);
    expect(cred.get).toHaveBeenCalledTimes(0);     // reuse path skipped
    expect(await wallet.hasBiometric()).toBe(true);
  }, 60_000);

  it("unlockWithBiometric maps decrypt failure to BIOMETRIC_DECRYPT_FAILED", async () => {
    const cred = makeBiometricCredentialsMock();
    const { wallet } = makeModule({ credentialsImpl: cred });
    await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
    wallet.lock();
    // Corrupt the wrapped seed key so the AES-GCM unwrap fails. We can't
    // reach into IDB easily here without a helper, so the cleanest path is
    // to make get() return DIFFERENT PRF bytes than were used to wrap the
    // key — same effect on decrypt: AES-GCM rejects with auth-tag mismatch.
    cred.get.mockResolvedValueOnce({
      getClientExtensionResults: () => ({
        prf: { results: { first: new Uint8Array(32).fill(0xfe) } }
      })
    });
    await expect(wallet.unlockWithBiometric()).rejects.toMatchObject({
      code: ERROR_CODES.BIOMETRIC_DECRYPT_FAILED
    });
  }, 60_000);

  it("wipeWallet returns hadBiometric reflecting prior enrollment", async () => {
    const cred = makeBiometricCredentialsMock();

    // Without biometric.
    {
      const { wallet } = makeModule({ credentialsImpl: cred });
      await wallet.createWallet({ pin: STRONG_PIN });
      const result = await wallet.wipeWallet(STRONG_PIN);
      expect(result).toEqual({ hadBiometric: false });
    }
    // With biometric.
    {
      const { wallet } = makeModule({ credentialsImpl: cred });
      await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
      const result = await wallet.wipeWallet(STRONG_PIN);
      expect(result).toEqual({ hadBiometric: true });
    }
  }, 60_000);

  // resetBiometric is the explicit recovery path for the iOS-deleted-passkey
  // loop (when the OS passkey was removed from Settings → Senhas, addBiometric
  // sits in a 60s NotAllowedError loop with no in-app recovery). The reset
  // hard-clears credentialId + prfSalt + wrappedSeedKey behind a PIN gate so
  // the next addBiometric falls through to fresh enroll.
  describe("resetBiometric", () => {
    it("hard-clears all biometric identifiers and lets next addBiometric fresh-enroll", async () => {
      const cred = makeBiometricCredentialsMock();
      const { wallet } = makeModule({ credentialsImpl: cred });
      await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });
      expect(cred.create).toHaveBeenCalledTimes(1);
      expect(await wallet.hasBiometric()).toBe(true);

      const result = await wallet.resetBiometric(STRONG_PIN);
      expect(result).toEqual({ hadBiometric: true });
      expect(await wallet.hasBiometric()).toBe(false);

      // Next addBiometric must call create() again — the soft-disabled
      // reuse path requires credentialId + prfSalt to be present.
      await wallet.addBiometric(STRONG_PIN);
      expect(cred.create).toHaveBeenCalledTimes(2); // fresh enroll, not reuse
      expect(await wallet.hasBiometric()).toBe(true);
    }, 60_000);

    it("rejects with WRONG_PIN when the PIN is wrong, leaves identifiers intact", async () => {
      const cred = makeBiometricCredentialsMock();
      const { wallet } = makeModule({ credentialsImpl: cred });
      await wallet.createWallet({ pin: STRONG_PIN, enrollBiometric: true });

      await expect(wallet.resetBiometric(SECOND_PIN)).rejects.toMatchObject({
        code: ERROR_CODES.WRONG_PIN
      });
      // Identifiers preserved — user can retry without losing biometric state.
      expect(await wallet.hasBiometric()).toBe(true);
    }, 60_000);

    it("returns hadBiometric=false when no biometric was ever enrolled", async () => {
      const cred = makeBiometricCredentialsMock();
      const { wallet } = makeModule({ credentialsImpl: cred });
      await wallet.createWallet({ pin: STRONG_PIN }); // no biometric

      const result = await wallet.resetBiometric(STRONG_PIN);
      expect(result).toEqual({ hadBiometric: false });
      expect(cred.create).toHaveBeenCalledTimes(0);
    }, 60_000);
  });
});
