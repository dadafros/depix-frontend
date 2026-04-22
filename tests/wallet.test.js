import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";

// LWK is too heavy to load in jsdom. The wallet module delegates all crypto-
// currency-specific work to the lwk namespace returned by `loadLwk`, so we
// inject a fake namespace via the `lwkLoader` dependency — no vi.mock needed.
function makeFakeLwk() {
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
      // Deterministic "random" for test reproducibility.
      const word = "abandon";
      const words = Array(11).fill(word).concat("about").join(" ");
      return new Mnemonic(words);
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

function makeModule({ clock, credentialsImpl } = {}) {
  const fakeLwk = makeFakeLwk();
  const idbFactory = new IDBFactory();
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
    await expect(wallet.wipeWallet(SECOND_PIN)).rejects.toBeDefined();
    expect(await wallet.hasWallet()).toBe(true);
  }, 60_000);
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
