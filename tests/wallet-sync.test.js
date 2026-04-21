// Tests for wallet.syncWallet() — the Esplora-backed full scan that powers
// the wallet home panel. Uses the same fake LWK pattern as wallet.test.js
// but adds an in-memory Update/EsploraClient and tracks persistence in the
// sync store.

import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { ERROR_CODES } from "../wallet/wallet-errors.js";

const STRONG_PIN = "702486";

function makeFakeLwkWithSync({ scanResult, throwOnScan } = {}) {
  class Mnemonic {
    constructor(str) {
      const words = String(str).trim().split(/\s+/);
      if (words.length !== 12) throw new Error("mnemonic must be 12 words");
      this._str = words.join(" ");
    }
    toString() { return this._str; }
    static fromRandom() {
      return new Mnemonic(Array(11).fill("abandon").concat("about").join(" "));
    }
  }
  class WolletDescriptor {
    constructor(str) { this._str = str; }
    toString() { return this._str; }
  }
  class Signer {
    constructor(m) { this._m = m.toString(); }
    wpkhSlip77Descriptor() { return new WolletDescriptor(`ct(fake-${this._m.replace(/\s+/g, "_")})`); }
    free() {}
  }
  class Address {
    constructor(s) { this._s = s; }
    toString() { return this._s; }
  }
  class AddressResult {
    constructor(s) { this._a = new Address(s); }
    address() { return this._a; }
  }
  class Update {
    constructor(bytes) { this._bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [1, 2, 3]); }
    serialize() { return this._bytes; }
    free() {}
  }
  // Track last applied update per-wallet so tests can assert the state
  // transition through sync.
  class Wollet {
    constructor(_net, desc) {
      this._desc = desc.toString();
      this._applied = [];
    }
    address(idx) { return new AddressResult(`lq1${this._desc}-${idx ?? 0}`); }
    balance() { return this._applied.length > 0 ? { applied: true } : { applied: false }; }
    transactions() { return []; }
    applyUpdate(u) { this._applied.push(u); }
    free() {}
  }
  class EsploraClient {
    constructor(_net, url, _waterfalls, _concurrency, _incremental) {
      this._url = url;
      this.freed = false;
    }
    async fullScan() {
      if (throwOnScan) throw new Error("esplora boom");
      return scanResult === undefined ? new Update(new Uint8Array([9, 9, 9])) : scanResult;
    }
    free() { this.freed = true; }
  }
  const Network = {
    mainnet: () => ({ _kind: "mainnet", defaultEsploraClient: () => new EsploraClient({}, null) }),
    testnet: () => ({ _kind: "testnet", defaultEsploraClient: () => new EsploraClient({}, null) }),
    regtestDefault: () => ({ _kind: "regtest", defaultEsploraClient: () => new EsploraClient({}, null) })
  };
  return { Mnemonic, Signer, WolletDescriptor, Wollet, Update, EsploraClient, Network };
}

function makeModule(overrides = {}) {
  const fakeLwk = makeFakeLwkWithSync(overrides);
  const clock = overrides.clock ?? (() => Date.now());
  return {
    fakeLwk,
    wallet: createWalletModule({
      indexedDbImpl: new IDBFactory(),
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk,
      clock,
      esploraUrl: "https://fake-esplora/api"
    })
  };
}

describe("wallet.syncWallet", () => {
  it("runs a fullScan and persists the update blob", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();

    const res = await wallet.syncWallet();
    expect(res.changed).toBe(true);
    expect(res.lastScanAt).toBeGreaterThan(0);
    expect(wallet.getLastScanAt()).toBe(res.lastScanAt);
  }, 60_000);

  it("bumps lastScanAt even when fullScan returns no update", async () => {
    const { wallet } = makeModule({ scanResult: null });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();

    const before = wallet.getLastScanAt();
    const res = await wallet.syncWallet();
    expect(res.changed).toBe(false);
    expect(res.lastScanAt).toBeGreaterThanOrEqual(before);
  }, 60_000);

  it("surfaces ESPLORA_UNAVAILABLE when fullScan throws", async () => {
    const { wallet } = makeModule({ throwOnScan: true });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();

    await expect(wallet.syncWallet()).rejects.toMatchObject({
      code: ERROR_CODES.ESPLORA_UNAVAILABLE
    });
  }, 60_000);

  it("applies cached Update blob on first view-only call (warm-start)", async () => {
    const { wallet, fakeLwk } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    // First sync persists an Update.
    await wallet.syncWallet();
    wallet.lock();

    // Re-read via ensureViewWollet — getBalances hydrates the cached Update.
    const bal = await wallet.getBalances();
    expect(bal.applied).toBe(true);
    expect(fakeLwk.Update).toBeDefined();
  }, 60_000);

  it("uses the injected esploraClientFactory when provided", async () => {
    const { fakeLwk } = makeModule();
    const factory = vi.fn(() => new fakeLwk.EsploraClient({}, "http://injected"));
    const wallet = createWalletModule({
      indexedDbImpl: new IDBFactory(),
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk,
      esploraClientFactory: factory
    });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await wallet.syncWallet();
    expect(factory).toHaveBeenCalled();
  }, 60_000);
});
