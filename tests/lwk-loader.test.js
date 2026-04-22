import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadLwk, _resetForTesting } from "../wallet/lwk-loader.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";
import {
  LOAD_BACKOFF_SCHEDULE_MS,
  MAX_LOAD_RETRIES
} from "../wallet/constants.js";

// `loadLwk` calls `WebAssembly.instantiate(bytes, imports)` with a fixed
// imports shape — the real lwk_wasm_bg.js glue. Building real bytes that
// satisfy those imports in a pure-JS test is both fragile and off-point:
// we're testing retry/singleton/cache-reset semantics, not WASM loading.
//
// So we stub `WebAssembly.instantiate` and `lwkBg.__wbg_set_wasm` for the
// whole suite — each test then controls the fetch result (ok/!ok/throw) and
// asserts the loader's flow.
const origInstantiate = WebAssembly.instantiate;

function makeResponse({ ok = true } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

function sentinelModule() {
  // Returned by the successful instantiate stub. The loader calls
  // `lwkBg.__wbg_set_wasm(instance.exports)` and optionally
  // `__wbindgen_start()`, then resolves with `lwkBg`. We don't assert on
  // what's returned (it's the real `lwkBg` namespace), just that it is
  // defined.
  return {
    instance: {
      exports: {
        __wbindgen_start: () => {}
      }
    }
  };
}

beforeEach(() => {
  _resetForTesting();
  WebAssembly.instantiate = vi.fn(async () => sentinelModule());
});

describe("lwk-loader singleton", () => {
  it("dedupes concurrent loadLwk() calls: only one fetch", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ ok: true }));
    const [a, b] = await Promise.all([
      loadLwk({ url: "fake://wasm", fetchImpl, delayImpl: async () => {} }),
      loadLwk({ url: "fake://wasm", fetchImpl, delayImpl: async () => {} })
    ]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the same cached promise on sequential success", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ ok: true }));
    const first = await loadLwk({ url: "fake://wasm", fetchImpl, delayImpl: async () => {} });
    const second = await loadLwk({ url: "fake://wasm", fetchImpl, delayImpl: async () => {} });
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("lwk-loader retry schedule", () => {
  it("fails N-1 times then succeeds on the Nth attempt, using injected delays", async () => {
    // Fail the first two attempts, succeed the third (MAX_LOAD_RETRIES=3).
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call < MAX_LOAD_RETRIES) return makeResponse({ ok: false });
      return makeResponse({ ok: true });
    });
    const delays = [];
    const delayImpl = vi.fn(async (ms) => { delays.push(ms); });

    const result = await loadLwk({ url: "fake://wasm", fetchImpl, delayImpl });
    expect(result).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LOAD_RETRIES);
    // Delays between attempts: after attempt 0 and attempt 1, but not after
    // the final attempt (that succeeded). The loader also skips the delay
    // when it's the last attempt, so we expect exactly the first two entries
    // of LOAD_BACKOFF_SCHEDULE_MS.
    expect(delays).toEqual(LOAD_BACKOFF_SCHEDULE_MS.slice(0, MAX_LOAD_RETRIES - 1));
  });
});

describe("lwk-loader failure handling", () => {
  it("throws a WalletError with LWK_LOAD_FAILED after exhausting all retries", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ ok: false }));
    const delayImpl = async () => {};
    let caught;
    try {
      await loadLwk({ url: "fake://wasm", fetchImpl, delayImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalletError);
    expect(caught.code).toBe(ERROR_CODES.LWK_LOAD_FAILED);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LOAD_RETRIES);
  });

  it("clears the cached promise on final failure so the next call retries", async () => {
    // Round 1: always fail.
    let round = 1;
    const fetchImpl = vi.fn(async () => {
      if (round === 1) return makeResponse({ ok: false });
      return makeResponse({ ok: true });
    });
    const delayImpl = async () => {};

    await expect(
      loadLwk({ url: "fake://wasm", fetchImpl, delayImpl })
    ).rejects.toBeInstanceOf(WalletError);
    const callsAfterRound1 = fetchImpl.mock.calls.length;
    expect(callsAfterRound1).toBe(MAX_LOAD_RETRIES);

    // Round 2: succeed. If the cache had NOT been cleared, loadLwk would
    // return the (rejected) cached promise and fetch would not run again.
    round = 2;
    const result = await loadLwk({ url: "fake://wasm", fetchImpl, delayImpl });
    expect(result).toBeDefined();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterRound1);
  });
});

// Restore the real instantiate after the suite so unrelated tests that
// import wallet.js aren't affected (vitest runs files in isolation, but be
// defensive).
describe("lwk-loader cleanup", () => {
  it("restores globals", () => {
    WebAssembly.instantiate = origInstantiate;
    expect(typeof WebAssembly.instantiate).toBe("function");
  });
});
