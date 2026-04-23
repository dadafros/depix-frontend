import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";
import { BIP39_WORDLIST } from "../wallet/bip39-wordlist.js";

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
      this._str = words.join(" ");
    }
    toString() { return this._str; }
    static fromRandom(_bits) {
      fromRandomCounter++;
      const words = [];
      for (let i = 0; i < 11; i++) {
        const idx = (fromRandomCounter * 37 + i * 17) % BIP39_WORDLIST.length;
        words.push(BIP39_WORDLIST[idx]);
      }
      // End with "about" so the 12th word is stable across calls — matches
      // the classic "abandon ... about" convention used elsewhere in tests.
      words.push("about");
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
      "exportMnemonic",
      "wipeWallet",
      "addBiometric",
      "removeBiometric",
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
