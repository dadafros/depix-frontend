// @vitest-environment jsdom
//
// Covers wallet/wallet-tx-filter.js — the pure helpers behind
// #wallet-transactions filtering, field extraction, and period presets.
// The closure in wallet-ui.js only wires these into the DOM; keeping the
// logic unit-tested here means a wasm rename or filter-semantics tweak
// surfaces as a failing assertion rather than a silent UI regression.

import { describe, it, expect } from "vitest";
import { ASSETS } from "../wallet/asset-registry.js";
import {
  normalizeBalances,
  safeCall,
  extractTxAssets,
  txDirection,
  txTimestampMs,
  formatTxTimestamp,
  matchesWalletTxFilter,
  normalizeWalletTxSearch,
  walletTxDatesFromPeriod,
  dateStrToMs,
  txAssetSymbols,
  txSearchHaystack
} from "../wallet/wallet-tx-filter.js";

const DEPIX_ID = ASSETS.DEPIX.id;
const USDT_ID = ASSETS.USDT.id;
const LBTC_ID = ASSETS.LBTC.id;
const UNKNOWN_ASSET_ID = "a".repeat(64);

// ---- fixtures ------------------------------------------------------------
// Shape mirrors the LWK wasm WalletTx surface (methods, not fields).

function makeTx({ type, ts, txid, balance } = {}) {
  return {
    type: type === undefined ? undefined : () => type,
    timestamp: ts === undefined ? undefined : () => ts,
    txid: txid === undefined ? undefined : () => ({ toString: () => txid }),
    balance: () => balance ?? new Map()
  };
}

function balanceMap(entries) {
  const m = new Map();
  for (const [k, v] of entries) m.set({ toString: () => k }, v);
  return m;
}

// ---- normalizeBalances ---------------------------------------------------

describe("normalizeBalances", () => {
  it("accepts a Map<AssetId, bigint|number> and coerces values to BigInt", () => {
    const m = balanceMap([[DEPIX_ID, 100n], [USDT_ID, 200]]);
    const out = normalizeBalances(m);
    expect(out[DEPIX_ID]).toBe(100n);
    expect(out[USDT_ID]).toBe(200n);
  });

  it("accepts a plain object (test-stub shape) and coerces to BigInt", () => {
    const out = normalizeBalances({ [DEPIX_ID]: 50, [LBTC_ID]: 10n });
    expect(out[DEPIX_ID]).toBe(50n);
    expect(out[LBTC_ID]).toBe(10n);
  });

  it("returns an empty prototype-free object for null/undefined input", () => {
    const out = normalizeBalances(null);
    expect(out).toEqual({});
    expect(Object.getPrototypeOf(out)).toBe(null);
  });
});

// ---- safeCall ------------------------------------------------------------

describe("safeCall", () => {
  it("returns the method result when present", () => {
    expect(safeCall({ foo: () => "bar" }, "foo")).toBe("bar");
  });

  it("returns undefined when the method is absent (silent, no throw)", () => {
    expect(safeCall({}, "foo")).toBeUndefined();
    expect(safeCall(null, "foo")).toBeUndefined();
    expect(safeCall(undefined, "foo")).toBeUndefined();
  });

  it("swallows method-thrown errors and returns undefined", () => {
    const obj = { foo() { throw new Error("boom"); } };
    expect(safeCall(obj, "foo")).toBeUndefined();
  });
});

// ---- extractTxAssets + txAssetSymbols ------------------------------------

describe("extractTxAssets", () => {
  it("returns the normalized balance map for a well-formed tx", () => {
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 500n]]) });
    expect(extractTxAssets(tx)).toEqual({ [DEPIX_ID]: 500n });
  });

  it("returns empty when balance() throws", () => {
    const tx = { balance() { throw new Error("wasm dead"); } };
    expect(extractTxAssets(tx)).toEqual({});
  });

  it("returns empty when balance is not a function", () => {
    expect(extractTxAssets({ balance: {} })).toEqual({});
    expect(extractTxAssets({})).toEqual({});
  });
});

describe("txAssetSymbols", () => {
  it("maps known asset ids to pill symbols", () => {
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 1n], [USDT_ID, -1n]]) });
    const syms = txAssetSymbols(tx);
    expect(syms.has("DEPIX")).toBe(true);
    expect(syms.has("USDT")).toBe(true);
    expect(syms.size).toBe(2);
  });

  it("drops unknown asset ids (would be 'other' in the UI)", () => {
    const tx = makeTx({ balance: balanceMap([[UNKNOWN_ASSET_ID, 42n]]) });
    expect(txAssetSymbols(tx).size).toBe(0);
  });
});

// ---- txDirection ---------------------------------------------------------

describe("txDirection", () => {
  it("trusts LWK's explicit type() when present", () => {
    expect(txDirection(makeTx({ type: "incoming", balance: balanceMap([[DEPIX_ID, -1n]]) }))).toBe("in");
    expect(txDirection(makeTx({ type: "outgoing", balance: balanceMap([[DEPIX_ID, 1n]]) }))).toBe("out");
  });

  it("falls back to balance sign when type() is missing", () => {
    expect(txDirection(makeTx({ balance: balanceMap([[DEPIX_ID, 100n]]) }))).toBe("in");
    expect(txDirection(makeTx({ balance: balanceMap([[DEPIX_ID, -100n]]) }))).toBe("out");
  });

  it("returns 'other' for mixed-sign balances (can't disambiguate without type())", () => {
    const mixed = makeTx({ balance: balanceMap([[DEPIX_ID, 10n], [USDT_ID, -5n]]) });
    expect(txDirection(mixed)).toBe("other");
  });

  it("returns 'other' for zero-balance / empty tx", () => {
    expect(txDirection(makeTx({ balance: new Map() }))).toBe("other");
  });
});

// ---- txTimestampMs -------------------------------------------------------

describe("txTimestampMs", () => {
  it("auto-upscales LWK seconds to epoch millis (< 1e12)", () => {
    expect(txTimestampMs(makeTx({ ts: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  it("keeps millis when already > 1e12", () => {
    expect(txTimestampMs(makeTx({ ts: 1_700_000_000_000 }))).toBe(1_700_000_000_000);
  });

  it("returns null for missing / non-finite / non-positive timestamps", () => {
    expect(txTimestampMs(makeTx({ ts: undefined }))).toBe(null);
    expect(txTimestampMs(makeTx({ ts: 0 }))).toBe(null);
    expect(txTimestampMs(makeTx({ ts: -1 }))).toBe(null);
    expect(txTimestampMs(makeTx({ ts: NaN }))).toBe(null);
  });
});

// ---- formatTxTimestamp ---------------------------------------------------

describe("formatTxTimestamp", () => {
  it("renders a pt-BR date/time string for valid timestamps", () => {
    const out = formatTxTimestamp(1_700_000_000);
    expect(typeof out).toBe("string");
    expect(out).not.toBe("—");
    // Expect the pt-BR date pattern dd/mm/yyyy somewhere in the output.
    expect(out).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("returns '—' for missing / zero / non-finite input", () => {
    expect(formatTxTimestamp(undefined)).toBe("—");
    expect(formatTxTimestamp(0)).toBe("—");
    expect(formatTxTimestamp(NaN)).toBe("—");
  });
});

// ---- dateStrToMs ---------------------------------------------------------

describe("dateStrToMs", () => {
  it("returns midnight-local for the start-of-day variant", () => {
    const ms = dateStrToMs("2026-04-24", false);
    const dt = new Date(ms);
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(3);
    expect(dt.getDate()).toBe(24);
    expect(dt.getHours()).toBe(0);
    expect(dt.getMinutes()).toBe(0);
  });

  it("returns end-of-day 23:59:59.999 for the endOfDay variant (inclusive)", () => {
    const ms = dateStrToMs("2026-04-24", true);
    const dt = new Date(ms);
    expect(dt.getHours()).toBe(23);
    expect(dt.getMinutes()).toBe(59);
    expect(dt.getSeconds()).toBe(59);
    expect(dt.getMilliseconds()).toBe(999);
  });

  it("returns null for empty / malformed input", () => {
    expect(dateStrToMs("")).toBe(null);
    expect(dateStrToMs(null)).toBe(null);
    expect(dateStrToMs("not-a-date")).toBe(null);
    expect(dateStrToMs("2026--24")).toBe(null);
  });
});

// ---- txSearchHaystack ----------------------------------------------------

describe("txSearchHaystack", () => {
  it("includes the txid (lowercased) so hex searches hit", () => {
    const tx = makeTx({ txid: "ABCDEF0011", balance: balanceMap([[DEPIX_ID, 1n]]) });
    expect(txSearchHaystack(tx)).toContain("abcdef0011");
  });

  it("includes the asset symbol (case-normalized) and amount", () => {
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 100_000_000n]]) });
    const hay = txSearchHaystack(tx);
    expect(hay).toContain("depix");
  });

  it("is empty when the tx has no fields", () => {
    expect(txSearchHaystack(makeTx({}))).toBe("");
  });
});

// ---- normalizeWalletTxSearch --------------------------------------------

describe("normalizeWalletTxSearch", () => {
  it("trims, lowercases, and flips ',' → '.'", () => {
    expect(normalizeWalletTxSearch("  Hello ")).toBe("hello");
    expect(normalizeWalletTxSearch("1,5")).toBe("1.5");
    expect(normalizeWalletTxSearch("ABC,def,1,5")).toBe("abc.def.1.5");
  });

  it("coerces null/undefined to empty string", () => {
    expect(normalizeWalletTxSearch(null)).toBe("");
    expect(normalizeWalletTxSearch(undefined)).toBe("");
  });
});

// ---- matchesWalletTxFilter ----------------------------------------------

const ALL_FILTER = {
  asset: "all",
  direction: "all",
  period: "all",
  startDate: "",
  endDate: "",
  search: ""
};

describe("matchesWalletTxFilter", () => {
  it("matches everything with the default all-filter", () => {
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 1n]]) });
    expect(matchesWalletTxFilter(tx, ALL_FILTER)).toBe(true);
  });

  it("handles a null filter as match-all (fail-open)", () => {
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 1n]]) });
    expect(matchesWalletTxFilter(tx, null)).toBe(true);
  });

  it("filters by asset symbol", () => {
    const depixTx = makeTx({ balance: balanceMap([[DEPIX_ID, 1n]]) });
    const usdtTx = makeTx({ balance: balanceMap([[USDT_ID, 1n]]) });
    expect(matchesWalletTxFilter(depixTx, { ...ALL_FILTER, asset: "DEPIX" })).toBe(true);
    expect(matchesWalletTxFilter(usdtTx, { ...ALL_FILTER, asset: "DEPIX" })).toBe(false);
  });

  it("filters by direction (in / out)", () => {
    const inTx = makeTx({ balance: balanceMap([[DEPIX_ID, 100n]]) });
    const outTx = makeTx({ balance: balanceMap([[DEPIX_ID, -100n]]) });
    expect(matchesWalletTxFilter(inTx, { ...ALL_FILTER, direction: "in" })).toBe(true);
    expect(matchesWalletTxFilter(outTx, { ...ALL_FILTER, direction: "in" })).toBe(false);
    expect(matchesWalletTxFilter(outTx, { ...ALL_FILTER, direction: "out" })).toBe(true);
  });

  it("filters by inclusive date range (end-of-day honors ms=999 boundary)", () => {
    const apr24 = new Date(2026, 3, 24, 12, 0, 0).getTime() / 1000;
    const apr25 = new Date(2026, 3, 25, 12, 0, 0).getTime() / 1000;
    const apr26 = new Date(2026, 3, 26, 12, 0, 0).getTime() / 1000;
    const mk = ts => makeTx({ ts, balance: balanceMap([[DEPIX_ID, 1n]]) });
    const range = { ...ALL_FILTER, startDate: "2026-04-25", endDate: "2026-04-25" };
    expect(matchesWalletTxFilter(mk(apr24), range)).toBe(false);
    expect(matchesWalletTxFilter(mk(apr25), range)).toBe(true);
    expect(matchesWalletTxFilter(mk(apr26), range)).toBe(false);
  });

  it("rejects txs without a timestamp when any date filter is set", () => {
    const tx = makeTx({ ts: undefined, balance: balanceMap([[DEPIX_ID, 1n]]) });
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, startDate: "2026-01-01" })).toBe(false);
    expect(matchesWalletTxFilter(tx, ALL_FILTER)).toBe(true);
  });

  it("filters by search (substring, case-insensitive, normalized internally)", () => {
    const tx = makeTx({ txid: "AABBCCddeeff", balance: balanceMap([[DEPIX_ID, 1n]]) });
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, search: "ddeeff" })).toBe(true);
    // Predicate now lowercases defensively — a caller that forgets the
    // transform still gets correct results.
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, search: "ddEEff" })).toBe(true);
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, search: "xxxxxx" })).toBe(false);
  });

  it("accepts Brazilian-style decimal in search (', '→'.')", () => {
    // formatAssetAmount uses '.' as decimal separator; Brazilian users
    // type ',' — the predicate normalizes so both hit.
    const tx = makeTx({ balance: balanceMap([[DEPIX_ID, 150_000_000n]]) });
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, search: "1.5" })).toBe(true);
    expect(matchesWalletTxFilter(tx, { ...ALL_FILTER, search: "1,5" })).toBe(true);
  });

  it("combines filters with AND semantics", () => {
    const tx = makeTx({
      type: "incoming",
      ts: new Date(2026, 3, 25, 12, 0, 0).getTime() / 1000,
      balance: balanceMap([[DEPIX_ID, 1n]])
    });
    const hit = {
      asset: "DEPIX",
      direction: "in",
      period: "custom",
      startDate: "2026-04-25",
      endDate: "2026-04-25",
      search: ""
    };
    expect(matchesWalletTxFilter(tx, hit)).toBe(true);
    expect(matchesWalletTxFilter(tx, { ...hit, asset: "USDT" })).toBe(false);
    expect(matchesWalletTxFilter(tx, { ...hit, direction: "out" })).toBe(false);
    expect(matchesWalletTxFilter(tx, { ...hit, endDate: "2026-04-24" })).toBe(false);
  });
});

// ---- walletTxDatesFromPeriod ---------------------------------------------

describe("walletTxDatesFromPeriod", () => {
  // Freeze clock at 2026-04-25 noon São Paulo (UTC-3) — the helper reads
  // `toLocaleDateString(..., { timeZone: "America/Sao_Paulo" })` so we must
  // pick a time far enough from midnight that DST-free tz conversion is
  // unambiguous.
  const fixed = new Date("2026-04-25T15:00:00Z"); // 12:00 São Paulo

  it("today → today..today", () => {
    expect(walletTxDatesFromPeriod("today", fixed)).toEqual({
      start: "2026-04-25",
      end: "2026-04-25"
    });
  });

  it("7d → today-6 .. today (7-day inclusive window)", () => {
    expect(walletTxDatesFromPeriod("7d", fixed)).toEqual({
      start: "2026-04-19",
      end: "2026-04-25"
    });
  });

  it("30d → today-29 .. today", () => {
    expect(walletTxDatesFromPeriod("30d", fixed)).toEqual({
      start: "2026-03-27",
      end: "2026-04-25"
    });
  });

  it("90d → today-89 .. today", () => {
    expect(walletTxDatesFromPeriod("90d", fixed)).toEqual({
      start: "2026-01-26",
      end: "2026-04-25"
    });
  });

  it("all / custom / unknown → empty range (caller keeps whatever's typed)", () => {
    expect(walletTxDatesFromPeriod("all", fixed)).toEqual({ start: "", end: "" });
    expect(walletTxDatesFromPeriod("custom", fixed)).toEqual({ start: "", end: "" });
    expect(walletTxDatesFromPeriod("bogus", fixed)).toEqual({ start: "", end: "" });
  });

  it("does not mutate the injected `now` Date", () => {
    const before = fixed.getTime();
    walletTxDatesFromPeriod("30d", fixed);
    expect(fixed.getTime()).toBe(before);
  });
});
