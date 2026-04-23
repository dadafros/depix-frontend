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

function makeFakeLwkWithSync({
  scanResult,
  throwOnScan,
  fullScanError,
  fullScanHold
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
      EsploraClient.calls = (EsploraClient.calls ?? 0) + 1;
      EsploraClient.urls = (EsploraClient.urls ?? []);
      EsploraClient.urls.push(url);
    }
    async fullScan() {
      EsploraClient.scanCalls = (EsploraClient.scanCalls ?? 0) + 1;
      // `fullScanHold` is the test-provided gate promise. We await it so
      // the test can fan out concurrent syncWallet calls before releasing.
      if (fullScanHold) await fullScanHold;
      if (fullScanError) throw fullScanError;
      if (throwOnScan) throw new Error("esplora boom");
      return scanResult === undefined ? new Update(new Uint8Array([9, 9, 9])) : scanResult;
    }
    free() { this.freed = true; }
  }
  EsploraClient.calls = 0;
  EsploraClient.scanCalls = 0;
  EsploraClient.urls = [];
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

  describe("dedup (syncInFlight)", () => {
    it("three concurrent syncWallet calls share one in-flight fullScan", async () => {
      let release;
      const hold = new Promise(r => { release = r; });
      const { fakeLwk, wallet } = makeModule({ fullScanHold: hold });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      fakeLwk.EsploraClient.scanCalls = 0;
      fakeLwk.EsploraClient.calls = 0;

      const p1 = wallet.syncWallet();
      const p2 = wallet.syncWallet();
      const p3 = wallet.syncWallet();
      // All three must be the exact same promise — we dedup by reference.
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);

      // Release the single held fullScan and let everyone resolve.
      release();
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
      expect(fakeLwk.EsploraClient.scanCalls).toBe(1);
      // One EsploraClient instance too — no duplicate clients allocated.
      expect(fakeLwk.EsploraClient.calls).toBe(1);
    }, 60_000);

    it("a sync following a completed sync starts a fresh scan", async () => {
      const { fakeLwk, wallet } = makeModule();
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      fakeLwk.EsploraClient.scanCalls = 0;

      await wallet.syncWallet();
      await wallet.syncWallet();
      expect(fakeLwk.EsploraClient.scanCalls).toBe(2);
    }, 60_000);
  });

  describe("ESPLORA_RATE_LIMITED (HTTP 429)", () => {
    it("throws ESPLORA_RATE_LIMITED when fullScan error message contains '429'", async () => {
      const { wallet } = makeModule({
        fullScanError: new Error("error response 429 Too Many Requests")
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 60_000);

    it("matches 'too many requests' case-insensitively", async () => {
      const { wallet } = makeModule({
        fullScanError: new Error("Esplora: TOO MANY REQUESTS please retry later")
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 60_000);

    it("walks the cause chain so wrapped 429 errors still classify", async () => {
      const root = new Error("status 429");
      const mid = new Error("sync failed");
      mid.cause = root;
      const outer = new Error("scan aborted");
      outer.cause = mid;
      const { wallet } = makeModule({ fullScanError: outer });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 60_000);

    it("non-429 errors still surface as ESPLORA_UNAVAILABLE", async () => {
      const { wallet } = makeModule({
        fullScanError: new Error("socket hang up")
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_UNAVAILABLE
      });
    }, 60_000);

    it("releases syncPromise after a failure so the next call retries", async () => {
      const { fakeLwk, wallet } = makeModule({ throwOnScan: true });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();
      fakeLwk.EsploraClient.scanCalls = 0;
      await expect(wallet.syncWallet()).rejects.toThrow();
      await expect(wallet.syncWallet()).rejects.toThrow();
      // Two actual scan calls — the failed syncPromise was cleared, not
      // memoized, so the second call dispatched a fresh scan.
      expect(fakeLwk.EsploraClient.scanCalls).toBe(2);
    }, 60_000);
  });

  // ----------------------------------------------------------------------
  // Provider fallback — each wallet module holds an ordered list of Esplora
  // endpoints. A 429 or network error on one provider should fall through
  // to the next; only when every provider in the list fails do we surface
  // ESPLORA_RATE_LIMITED / ESPLORA_UNAVAILABLE to the UI.
  // ----------------------------------------------------------------------
  describe("provider fallback", () => {
    // Build a wallet with two providers (A + B) and a per-provider client
    // factory so each test can script the exact sequence of outcomes.
    function makeFallbackModule({ outcomes, clock } = {}) {
      const fakeLwk = makeFakeLwkWithSync();
      const providers = [
        { name: "provA", url: "https://a.example/api" },
        { name: "provB", url: "https://b.example/api" }
      ];
      const factoryCalls = [];
      const factory = (_l, _net, provider) => {
        factoryCalls.push(provider);
        const client = new fakeLwk.EsploraClient(_net, provider.url);
        // Pick the outcome scripted for THIS provider. Supported values:
        //   { ok: true }          — resolve with a default Update
        //   { throw: Error }      — reject with that error
        //   missing               — same as { ok: true }
        const outcome = outcomes[provider.name];
        client.fullScan = async () => {
          fakeLwk.EsploraClient.scanCalls = (fakeLwk.EsploraClient.scanCalls ?? 0) + 1;
          if (outcome?.throw) throw outcome.throw;
          return new fakeLwk.Update(new Uint8Array([0xde, 0xad]));
        };
        return client;
      };
      const wallet = createWalletModule({
        indexedDbImpl: new IDBFactory(),
        cryptoImpl: webcrypto,
        lwkLoader: async () => fakeLwk,
        clock: clock ?? (() => Date.now()),
        esploraProviders: providers,
        esploraClientFactory: factory
      });
      return { fakeLwk, wallet, providers, factoryCalls };
    }

    it("uses the first provider on a cold start", async () => {
      const { wallet, factoryCalls } = makeFallbackModule({ outcomes: { provA: { ok: true } } });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      const res = await wallet.syncWallet();
      expect(res.changed).toBe(true);
      // Only provA was asked — provB never built a client.
      expect(factoryCalls.map(p => p.name)).toEqual(["provA"]);
    }, 60_000);

    it("falls through to the next provider on 429", async () => {
      const { wallet, factoryCalls } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("error response 429 Too Many Requests") },
          provB: { ok: true }
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      const res = await wallet.syncWallet();
      expect(res.changed).toBe(true);
      // provA was tried first, 429'd; provB picked up and succeeded.
      expect(factoryCalls.map(p => p.name)).toEqual(["provA", "provB"]);
    }, 60_000);

    it("falls through on a generic network error too", async () => {
      const { wallet, factoryCalls } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("socket hang up") },
          provB: { ok: true }
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await wallet.syncWallet();
      expect(factoryCalls.map(p => p.name)).toEqual(["provA", "provB"]);
    }, 60_000);

    it("subsequent syncs start from the last-good provider (sticky)", async () => {
      const { wallet, factoryCalls } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("429") },
          provB: { ok: true }
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await wallet.syncWallet();   // A → fails, B → ok. lastGood = B.
      factoryCalls.length = 0;
      await wallet.syncWallet();   // Should START at B, skipping A.
      expect(factoryCalls.map(p => p.name)).toEqual(["provB"]);
    }, 60_000);

    it("surfaces ESPLORA_RATE_LIMITED when every provider 429s", async () => {
      const { wallet } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("status 429") },
          provB: { throw: new Error("Too Many Requests") }
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 60_000);

    it("surfaces ESPLORA_UNAVAILABLE when every provider fails with a non-429 error", async () => {
      const { wallet } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("socket hang up") },
          provB: { throw: new Error("ECONNRESET") }
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_UNAVAILABLE
      });
    }, 60_000);

    it("mixed failures: any 429 in the chain surfaces RATE_LIMITED (UI backs off)", async () => {
      const { wallet } = makeFallbackModule({
        outcomes: {
          provA: { throw: new Error("ECONNRESET") },    // network error
          provB: { throw: new Error("status 429") }      // rate limit
        }
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 60_000);

    // Rediscovery — if the preferred provider 429s once at session start, we
    // stay on the fallback for `REDISCOVERY_INTERVAL` (10) syncs, then the
    // next sync re-tests the preferred provider. Guards against a permanent
    // demotion after a transient failure.
    it("rediscovers the preferred provider every 10 successful syncs", async () => {
      const fakeLwk = makeFakeLwkWithSync();
      const providers = [
        { name: "provA", url: "https://a.example/api" },
        { name: "provB", url: "https://b.example/api" }
      ];
      let provACallCount = 0;
      let provBCallCount = 0;
      const factory = (_l, _net, provider) => {
        const client = new fakeLwk.EsploraClient(_net, provider.url);
        client.fullScan = async () => {
          if (provider.name === "provA") {
            provACallCount++;
            // First call: simulate a transient 429 so the scheduler falls
            // through to provB. Subsequent calls succeed (the "recovered"
            // state we want rediscovery to find).
            if (provACallCount === 1) throw new Error("status 429");
          } else {
            provBCallCount++;
          }
          return new fakeLwk.Update(new Uint8Array([0xde, 0xad]));
        };
        return client;
      };
      const wallet = createWalletModule({
        indexedDbImpl: new IDBFactory(),
        cryptoImpl: webcrypto,
        lwkLoader: async () => fakeLwk,
        esploraProviders: providers,
        esploraClientFactory: factory
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      // Sync 1: A 429s (call #1), fallback to B succeeds. lastGood=B, counter=1.
      await wallet.syncWallet();
      expect(provACallCount).toBe(1);
      expect(provBCallCount).toBe(1);

      // Syncs 2-10: sticky on B. A is never touched. counter reaches 10.
      for (let i = 0; i < 9; i++) await wallet.syncWallet();
      expect(provACallCount).toBe(1);
      expect(provBCallCount).toBe(10);

      // Sync 11: counter >= 10, forceRediscovery resets startIndex to 0. A
      // now succeeds (its recovered-state second call). lastGood goes back to
      // A, counter resets.
      await wallet.syncWallet();
      expect(provACallCount).toBe(2);
      // B should NOT have been hit on sync 11 — A succeeded so we returned
      // without falling through.
      expect(provBCallCount).toBe(10);
    }, 60_000);
  });

  // ----------------------------------------------------------------------
  // Outer timeout — LWK 0.16.x retries 429s internally without ever
  // surfacing the error. We guard every provider attempt with a
  // Promise.race(SYNC_TIMEOUT_MS) so the fallback loop can move on when
  // the upstream client is hung. Tests inject a small timeout so the
  // assertion runs in milliseconds instead of 60s real-time.
  // ----------------------------------------------------------------------
  describe("SYNC_TIMEOUT_MS", () => {
    it("times out a hung fullScan and classifies the timeout as rate-limited", async () => {
      // fullScan never resolves — simulates the LWK retry loop wedge we
      // observed against Blockstream in dev. With syncTimeoutMs=50 the
      // outer Promise.race fires after 50ms and rejects with "rate limit"
      // in the synthetic message; isRateLimitError() routes that into
      // ESPLORA_RATE_LIMITED so the UI applies its backoff.
      const neverResolves = new Promise(() => {});
      const fakeLwk = makeFakeLwkWithSync({ fullScanHold: neverResolves });
      const wallet = createWalletModule({
        indexedDbImpl: new IDBFactory(),
        cryptoImpl: webcrypto,
        lwkLoader: async () => fakeLwk,
        esploraUrl: "https://fake-esplora/api",
        syncTimeoutMs: 50
      });
      await wallet.createWallet({ pin: STRONG_PIN });
      wallet.lock();

      await expect(wallet.syncWallet()).rejects.toMatchObject({
        code: ERROR_CODES.ESPLORA_RATE_LIMITED
      });
    }, 10_000);
  });
});
