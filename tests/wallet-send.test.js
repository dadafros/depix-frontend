// Tests for wallet.prepareSend() and wallet.confirmSend() — the PSET build +
// sign + broadcast path added in Sub-fase 5. Uses the same fake LWK pattern
// as wallet-sync.test.js but adds TxBuilder / Pset / Transaction plumbing
// so we can exercise the full send flow without a real WASM runtime.

import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { ERROR_CODES } from "../wallet/wallet-errors.js";
import { ASSETS } from "../wallet/asset-registry.js";

const STRONG_PIN = "702486";
const DEST = "lq1qqv0umk3pez693jrrlxz9ndlkuwne93gdu9g83mhhzuyf46e3mdzfpva0gyhjnfx7l";
const FAKE_TXID = "feedfacecafebeef112233445566778899aabbccddeeff00112233445566778899";

function makeFakeLwkWithSend({
  throwOnFinish = null,
  throwOnBroadcast = false,
  invalidAddress = false,
  txCountOnInit = 0
} = {}) {
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
    wpkhSlip77Descriptor() {
      return new WolletDescriptor(`ct(fake-${this._m.replace(/\s+/g, "_")})`);
    }
    sign(pset) {
      pset._signed = true;
      return pset;
    }
    free() {}
  }
  class Address {
    constructor(s) {
      if (invalidAddress) throw new Error("invalid address for this network");
      if (!s || typeof s !== "string") throw new Error("invalid address");
      this._s = s;
    }
    toString() { return this._s; }
  }
  class AddressResult {
    constructor(s) { this._a = new Address(s); }
    address() { return this._a; }
  }
  class AssetId {
    constructor(id) {
      if (!id || typeof id !== "string") throw new Error("invalid asset id");
      this._id = id;
    }
    toString() { return this._id; }
  }
  const psetByBase64 = new Map();
  class Pset {
    constructor(opts) {
      if (typeof opts === "string") {
        const existing = psetByBase64.get(opts);
        if (!existing) throw new Error("invalid pset base64: " + opts);
        return existing;
      }
      this._recipients = opts?.recipients ?? [];
      this._drain = Boolean(opts?.drain);
      this._base64 = `pset-b64-${opts?.ref ?? "x"}`;
      psetByBase64.set(this._base64, this);
    }
    toString() { return this._base64; }
  }
  class Transaction {
    constructor(pset) { this._pset = pset; }
    txid() { return { toString: () => FAKE_TXID }; }
    toString() { return `tx-hex-${this._pset?.toString?.() ?? ""}`; }
  }
  let builtPsets = [];
  class TxBuilder {
    constructor(net) {
      this._net = net;
      this._recipients = [];
      this._drain = false;
      this._feeRate = null;
    }
    // LWK's real TxBuilder is a CONSUMING builder — every method destroys
    // the JS wrapper via `__destroy_into_raw()` and returns a fresh instance.
    // Mirror that here so callers that forget to reassign (bug seen in
    // production: "null pointer passed to rust") fail loudly in tests.
    _consume() {
      if (this._consumed) {
        throw new Error("null pointer passed to rust (TxBuilder already consumed)");
      }
      this._consumed = true;
      const next = Object.create(TxBuilder.prototype);
      next._recipients = this._recipients;
      next._drain = this._drain;
      next._drainAddr = this._drainAddr;
      next._feeRate = this._feeRate;
      next._consumed = false;
      return next;
    }
    addLbtcRecipient(addr, sats) {
      const next = this._consume();
      next._recipients.push({ addr, sats, kind: "LBTC" });
      return next;
    }
    addRecipient(addr, sats, asset) {
      const next = this._consume();
      next._recipients.push({ addr, sats, asset: asset.toString(), kind: "ASSET" });
      return next;
    }
    drainLbtcWallet() { const n = this._consume(); n._drain = true; return n; }
    drainLbtcTo(addr) { const n = this._consume(); n._drainAddr = addr; return n; }
    feeRate(r) { const n = this._consume(); n._feeRate = r; return n; }
    finish(_wollet) {
      if (this._consumed) {
        throw new Error("null pointer passed to rust (TxBuilder already consumed)");
      }
      this._consumed = true;
      if (throwOnFinish === "insufficient") {
        const err = new Error("Insufficient funds for transaction");
        err.message = "insufficient_funds: not enough UTXOs";
        throw err;
      }
      if (throwOnFinish === "generic") {
        throw new Error("TxBuilder.finish generic failure");
      }
      const pset = new Pset({
        recipients: this._recipients,
        drain: this._drain,
        ref: builtPsets.length
      });
      builtPsets.push(pset);
      return pset;
    }
  }
  class Update {
    constructor(bytes) {
      this._bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [1, 2, 3]);
    }
    serialize() { return this._bytes; }
    free() {}
  }
  let scanCount = 0;
  class Wollet {
    constructor(_net, desc) {
      this._desc = desc.toString();
      this._applied = [];
      this._txs = new Array(txCountOnInit).fill(null).map((_, i) => ({
        txid: () => ({ toString: () => `tx-${i}` })
      }));
    }
    address(idx) {
      return new AddressResult(`lq1${this._desc}-${idx ?? 0}`);
    }
    balance() {
      return new Map([
        [ASSETS.LBTC.id, 500_000n],
        [ASSETS.DEPIX.id, 10_000_000n]
      ]);
    }
    transactions() { return this._txs; }
    applyUpdate(u) { this._applied.push(u); }
    finalize(pset) { pset._finalized = true; return pset; }
    psetDetails(pset) {
      return {
        balance: () => ({
          fee: () => 150n,
          balances: () => new Map([[{ toString: () => "someasset" }, -100_000n]]),
          recipients: () => pset._recipients.map(r => ({
            address: () => ({ toString: () => r.addr.toString() }),
            asset: () => ({ toString: () => r.asset ?? ASSETS.LBTC.id }),
            value: () => r.sats
          }))
        }),
        signatures: () => [],
        fingerprintsMissing: () => [],
        fingerprintsHas: () => []
      };
    }
    free() {}
  }
  class EsploraClient {
    constructor(_net, url) {
      this._url = url;
      this.broadcastCount = 0;
      this.scanCount = 0;
    }
    async fullScan(_w) {
      this.scanCount++;
      scanCount++;
      return new Update(new Uint8Array([scanCount, scanCount, scanCount]));
    }
    async broadcast(pset) {
      this.broadcastCount++;
      if (throwOnBroadcast) {
        const err = new Error("network down");
        throw err;
      }
      if (!pset._signed) throw new Error("pset not signed");
      if (!pset._finalized) throw new Error("pset not finalized");
      return { toString: () => FAKE_TXID };
    }
    async broadcastTx(_tx) {
      this.broadcastCount++;
      if (throwOnBroadcast) throw new Error("network down");
      return { toString: () => FAKE_TXID };
    }
    free() {}
  }
  const Network = {
    mainnet: () => ({
      _kind: "mainnet",
      defaultEsploraClient: () => new EsploraClient({}, null)
    }),
    testnet: () => ({ _kind: "testnet" }),
    regtestDefault: () => ({ _kind: "regtest" })
  };
  return {
    Mnemonic,
    Signer,
    WolletDescriptor,
    Address,
    AddressResult,
    AssetId,
    Pset,
    Transaction,
    TxBuilder,
    Update,
    Wollet,
    EsploraClient,
    Network,
    _getBuiltPsets: () => builtPsets
  };
}

function makeModule(overrides = {}) {
  const fakeLwk = makeFakeLwkWithSend(overrides);
  const esploraClients = [];
  return {
    fakeLwk,
    esploraClients,
    wallet: createWalletModule({
      indexedDbImpl: new IDBFactory(),
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk,
      esploraClientFactory: () => {
        const c = new fakeLwk.EsploraClient({}, "http://fake");
        esploraClients.push(c);
        return c;
      }
    })
  };
}

describe("wallet.prepareSend", () => {
  it("throws WALLET_NOT_FOUND when no wallet exists", async () => {
    const { wallet } = makeModule();
    await expect(wallet.prepareSend({
      asset: "DEPIX",
      amountSats: 100n,
      destAddr: DEST
    })).rejects.toMatchObject({
      code: ERROR_CODES.WALLET_NOT_FOUND
    });
  }, 60_000);

  it("throws INVALID_ADDRESS for a malformed destination", async () => {
    const { wallet } = makeModule({ invalidAddress: true });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await expect(wallet.prepareSend({
      asset: "DEPIX",
      amountSats: 1000n,
      destAddr: "not-a-real-address"
    })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_ADDRESS
    });
  }, 60_000);

  it("throws INVALID_AMOUNT for zero / negative / non-positive values", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    for (const bad of [0n, -1n, 0, -5, null, NaN]) {
      await expect(wallet.prepareSend({
        asset: "DEPIX",
        amountSats: bad,
        destAddr: DEST
      })).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_AMOUNT
      });
    }
  }, 60_000);

  it("throws UNSUPPORTED_ASSET for an unknown asset key", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await expect(wallet.prepareSend({
      asset: "BANANA",
      amountSats: 1000n,
      destAddr: DEST
    })).rejects.toMatchObject({
      code: ERROR_CODES.UNSUPPORTED_ASSET
    });
  }, 60_000);

  it("throws INSUFFICIENT_FUNDS when TxBuilder.finish reports it", async () => {
    const { wallet } = makeModule({ throwOnFinish: "insufficient" });
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await expect(wallet.prepareSend({
      asset: "LBTC",
      amountSats: 999_999_999_999n,
      destAddr: DEST
    })).rejects.toMatchObject({
      code: ERROR_CODES.INSUFFICIENT_FUNDS
    });
  }, 60_000);

  it("builds an LBTC send pset without requiring unlock (view-only)", async () => {
    const { wallet, fakeLwk } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    expect(wallet.isUnlocked()).toBe(false);
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    expect(wallet.isUnlocked()).toBe(false);
    expect(preview.psetBase64).toMatch(/^pset-b64-/);
    expect(preview.assetId).toBe(ASSETS.LBTC.id);
    expect(preview.amountSats).toBe(50_000n);
    expect(preview.destAddr).toBe(DEST);
    expect(typeof preview.feeSats).toBe("bigint");
    const psets = fakeLwk._getBuiltPsets();
    expect(psets).toHaveLength(1);
    expect(psets[0]._recipients[0].kind).toBe("LBTC");
    expect(psets[0]._recipients[0].sats).toBe(50_000n);
  }, 60_000);

  it("builds a DePix send pset with the mainnet asset id", async () => {
    const { wallet, fakeLwk } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await wallet.prepareSend({
      asset: "DEPIX",
      amountSats: 100_000n,
      destAddr: DEST
    });
    const psets = fakeLwk._getBuiltPsets();
    expect(psets[0]._recipients[0].kind).toBe("ASSET");
    expect(psets[0]._recipients[0].asset).toBe(ASSETS.DEPIX.id);
  }, 60_000);

  it("supports sendAll=true for LBTC via drainLbtcWallet", async () => {
    const { wallet, fakeLwk } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      destAddr: DEST,
      sendAll: true
    });
    expect(preview.sendAll).toBe(true);
    const psets = fakeLwk._getBuiltPsets();
    expect(psets[0]._drain).toBe(true);
    expect(psets[0]._recipients).toHaveLength(0);
  }, 60_000);

  it("rejects sendAll=true for non-LBTC assets", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    await expect(wallet.prepareSend({
      asset: "DEPIX",
      destAddr: DEST,
      sendAll: true
    })).rejects.toMatchObject({
      code: ERROR_CODES.SENDALL_NOT_SUPPORTED
    });
  }, 60_000);
});

describe("wallet.confirmSend", () => {
  it("throws WALLET_LOCKED when wallet is not unlocked", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    wallet.lock();
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    await expect(wallet.confirmSend(preview.psetBase64)).rejects.toMatchObject({
      code: ERROR_CODES.WALLET_LOCKED
    });
  }, 60_000);

  it("signs, finalizes, and broadcasts a prepared pset", async () => {
    const { wallet, esploraClients } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    const result = await wallet.confirmSend(preview.psetBase64);
    expect(result.txid).toBe(FAKE_TXID);
    const broadcastClient = esploraClients.find(c => c.broadcastCount > 0);
    expect(broadcastClient).toBeDefined();
    expect(broadcastClient.broadcastCount).toBe(1);
  }, 60_000);

  it("surfaces BROADCAST_FAILED when the Esplora broadcast throws", async () => {
    const { wallet } = makeModule({ throwOnBroadcast: true });
    await wallet.createWallet({ pin: STRONG_PIN });
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    await expect(wallet.confirmSend(preview.psetBase64)).rejects.toMatchObject({
      code: ERROR_CODES.BROADCAST_FAILED
    });
  }, 60_000);

  it("falls back to the second provider when the first broadcast fails", async () => {
    // Guards the multi-provider happy-fallback branch in confirmSend: when the
    // first provider refuses the tx but a later provider accepts it, we return
    // a valid txid instead of raising BROADCAST_FAILED. This is the branch
    // most likely to regress as the provider list evolves.
    const fakeLwk = makeFakeLwkWithSend();
    const esploraClients = [];
    const providers = [
      { name: "primary", url: "http://fake-primary" },
      { name: "secondary", url: "http://fake-secondary" }
    ];
    const wallet = createWalletModule({
      indexedDbImpl: new IDBFactory(),
      cryptoImpl: webcrypto,
      lwkLoader: async () => fakeLwk,
      esploraProviders: providers,
      esploraClientFactory: (_l, _net, provider) => {
        const c = new fakeLwk.EsploraClient({}, provider?.url);
        esploraClients.push(c);
        if (provider?.name === "primary") {
          c.broadcast = async () => {
            c.broadcastCount++;
            throw new Error("primary rejected");
          };
        }
        return c;
      }
    });
    await wallet.createWallet({ pin: STRONG_PIN });
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    const { txid } = await wallet.confirmSend(preview.psetBase64);
    expect(txid).toBe(FAKE_TXID);
    const primary = esploraClients.filter(c => c._url === "http://fake-primary");
    const secondary = esploraClients.filter(c => c._url === "http://fake-secondary");
    expect(primary.some(c => c.broadcastCount >= 1)).toBe(true);
    expect(secondary.some(c => c.broadcastCount >= 1)).toBe(true);
  }, 60_000);

  it("re-syncs the wallet after a successful broadcast", async () => {
    const { wallet, esploraClients } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 50_000n,
      destAddr: DEST
    });
    await wallet.confirmSend(preview.psetBase64);
    const totalScans = esploraClients.reduce((a, c) => a + c.scanCount, 0);
    expect(totalScans).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("rejects a pset that does not match the prepared one (basic sanity)", async () => {
    const { wallet } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    await expect(wallet.confirmSend("not-a-real-pset-string"))
      .rejects.toThrow();
  }, 60_000);
});

describe("wallet.prepareSend + confirmSend — happy path end-to-end", () => {
  it("DePix send round-trip exercises every LWK seam", async () => {
    const { wallet, fakeLwk, esploraClients } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    const preview = await wallet.prepareSend({
      asset: "DEPIX",
      amountSats: 25_000n,
      destAddr: DEST
    });
    expect(preview.feeSats).toBeGreaterThan(0n);
    const { txid } = await wallet.confirmSend(preview.psetBase64);
    expect(txid).toBe(FAKE_TXID);
    const psets = fakeLwk._getBuiltPsets();
    expect(psets[0]._signed).toBe(true);
    expect(psets[0]._finalized).toBe(true);
    expect(esploraClients.some(c => c.broadcastCount === 1)).toBe(true);
  }, 60_000);

  it("vi.fn spies confirm signer.sign is called exactly once per confirmSend", async () => {
    const { wallet, fakeLwk } = makeModule();
    await wallet.createWallet({ pin: STRONG_PIN });
    const signSpy = vi.spyOn(fakeLwk.Signer.prototype, "sign");
    const preview = await wallet.prepareSend({
      asset: "LBTC",
      amountSats: 10_000n,
      destAddr: DEST
    });
    await wallet.confirmSend(preview.psetBase64);
    expect(signSpy).toHaveBeenCalledTimes(1);
  }, 60_000);
});
