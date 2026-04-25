// Pure helpers for the #wallet-transactions list: balance normalization,
// field extraction, filter predicate, period presets, timestamp formatting.
//
// Extracted from wallet-ui.js so the filter/paginate/search logic can be
// unit-tested without spinning up the full wallet bundle + DOM. wallet-ui.js
// keeps the DOM wiring (observer, row builder, pill listeners) and delegates
// every data-shape decision to the exports below.
//
// All functions are side-effect-free and take plain inputs — the LWK tx
// objects appear here as `{ balance: () => Map|object, type: () => string,
// timestamp: () => number, txid: () => { toString: () => string } | string }`.
// Tests pass literal fixtures with that shape instead of the real wasm
// classes; wallet-ui.js passes the real wasm objects.

import { getAssetByIdentifier, formatAssetAmount } from "./asset-registry.js";

// LWK wasm returns balances as a Map<AssetId, bigint|number>. Normalize to a
// plain object keyed by asset-id hex string with BigInt values so downstream
// code can iterate predictably in both the real bundle and test mocks.
export function normalizeBalances(raw) {
  const out = Object.create(null);
  if (!raw) return out;
  const entries = typeof raw.entries === "function"
    ? raw.entries()
    : Array.isArray(raw) ? raw : null;
  if (entries) {
    for (const [k, v] of entries) {
      const keyStr = (k && typeof k.toString === "function") ? k.toString() : String(k);
      out[keyStr] = (typeof v === "bigint") ? v : BigInt(v ?? 0);
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      out[k] = (typeof v === "bigint") ? v : BigInt(v ?? 0);
    }
  }
  return out;
}

// Call `obj[name]()` defensively: returns undefined if the method is absent
// or throws. A thrown error is logged with a grep-able prefix so LWK upgrades
// that rename balance()/type()/timestamp()/txid() surface in devtools instead
// of silently rendering "—"/"tx". Absent/non-function fields stay silent.
export function safeCall(obj, name) {
  try {
    const fn = obj?.[name];
    if (typeof fn === "function") return fn.call(obj);
  } catch (err) {
    // Intentional signal on wasm rename — surfaces in devtools during LWK
    // upgrades instead of silently rendering "—"/"tx" everywhere.
    console.warn("[wallet-tx] safeCall", name, err);
  }
  return undefined;
}

export function extractTxAssets(tx) {
  try {
    const raw = typeof tx?.balance === "function" ? tx.balance() : null;
    return normalizeBalances(raw);
  } catch {
    return {};
  }
}

// Map asset-id hex → filter symbol ("DEPIX"/"USDT"/"LBTC"). Unknown asset ids
// are dropped so a tx with only unknown assets matches only when filter=all.
export function txAssetSymbols(tx) {
  const out = new Set();
  const assets = extractTxAssets(tx);
  for (const id of Object.keys(assets)) {
    const a = getAssetByIdentifier(id);
    if (!a) continue;
    if (a.symbol === "DePix") out.add("DEPIX");
    else if (a.symbol === "USDt") out.add("USDT");
    else if (a.symbol === "L-BTC") out.add("LBTC");
  }
  return out;
}

// Prefer LWK's explicit `type()` ("incoming"/"outgoing"); fall back to the
// sign of aggregate balance for wasm stubs that don't implement type().
// Returns "other" for mixed (both +/-) or empty balances so the pill filter
// can distinguish them from clear in/out txs.
export function txDirection(tx) {
  const type = safeCall(tx, "type");
  if (type === "incoming") return "in";
  if (type === "outgoing") return "out";
  const assets = extractTxAssets(tx);
  const anyPositive = Object.values(assets).some(v => v > 0n);
  const anyNegative = Object.values(assets).some(v => v < 0n);
  if (anyPositive && !anyNegative) return "in";
  if (anyNegative && !anyPositive) return "out";
  return "other";
}

// Normalize LWK's timestamp to epoch milliseconds. Mainline LWK emits
// seconds; some test stubs emit milliseconds already, so we auto-detect
// by magnitude (anything < 1e12 is seconds). Returns null for missing or
// invalid input — matches.js then treats "no timestamp" as "outside any
// date range" so unconfirmed txs disappear when the user picks a range.
export function txTimestampMs(tx) {
  const ts = safeCall(tx, "timestamp");
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

// Build the lowercase haystack used by the search box: txid + each asset's
// human-readable amount string + each asset symbol. Joined by spaces so a
// search for "depix" or part of a txid hex still matches.
export function txSearchHaystack(tx) {
  const parts = [];
  const txid = safeCall(tx, "txid");
  if (txid) parts.push(String(txid.toString ? txid.toString() : txid));
  const assets = extractTxAssets(tx);
  for (const id of Object.keys(assets)) {
    const a = getAssetByIdentifier(id);
    if (!a) continue;
    const sats = assets[id];
    const absSats = sats < 0n ? -sats : sats;
    parts.push(formatAssetAmount(absSats, a));
    parts.push(a.symbol);
  }
  return parts.join(" ").toLowerCase();
}

// Parse a `yyyy-mm-dd` date-input string to epoch ms in local time. The
// endOfDay=true variant pins to 23:59:59.999 so inclusive-day ranges work
// when compared against a tx timestamp.
export function dateStrToMs(yyyymmdd, endOfDay) {
  if (!yyyymmdd) return null;
  const [y, m, dd] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !dd) return null;
  const dt = new Date(y, m - 1, dd, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Pretty-print a wallet tx timestamp for the row subtitle. Returns "—" on
// missing/invalid input so rows don't silently drop the date.
export function formatTxTimestamp(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "—";
  const millis = ts < 1e12 ? ts * 1000 : ts;
  try {
    return new Date(millis).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "—";
  }
}

// Normalize a user-typed search query: lowercase (case-insensitive match)
// and flip "," to "." so a Brazilian user typing "1,5" still hits amount
// strings the LWK formatter renders with "." as the decimal separator.
// Exported so the caller can mirror the same transform when displaying
// the "active filter" chip, etc.
export function normalizeWalletTxSearch(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/,/g, ".");
}

// Main filter predicate. `filter` is the state object from wallet-ui.js:
// { asset, direction, period, startDate, endDate, search } — treated as
// plain data so tests don't need to touch the closure. `period` is kept on
// the object purely for the badge count; the actual range comes from
// startDate/endDate (which the click handler pre-populates from presets).
// Search is normalized internally (lowercase + comma→period) so the
// predicate stays correct even if a caller forgets to pre-normalize.
export function matchesWalletTxFilter(tx, filter) {
  if (!filter) return true;
  if (filter.asset && filter.asset !== "all") {
    const symbols = txAssetSymbols(tx);
    if (!symbols.has(filter.asset)) return false;
  }
  if (filter.direction && filter.direction !== "all") {
    if (txDirection(tx) !== filter.direction) return false;
  }
  const startMs = dateStrToMs(filter.startDate, false);
  const endMs = dateStrToMs(filter.endDate, true);
  if (startMs !== null || endMs !== null) {
    const ms = txTimestampMs(tx);
    if (ms === null) return false;
    if (startMs !== null && ms < startMs) return false;
    if (endMs !== null && ms > endMs) return false;
  }
  const needle = normalizeWalletTxSearch(filter.search);
  if (needle) {
    const haystack = txSearchHaystack(tx);
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// Translate a period preset pill to a { start, end } pair of yyyy-mm-dd
// strings anchored to the user's local day in America/Sao_Paulo. `now` is
// injected so tests can freeze the clock without stubbing Date.
export function walletTxDatesFromPeriod(period, now = new Date()) {
  const fmt = dt => dt.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const today = fmt(now);
  if (period === "today") return { start: today, end: today };
  const offsets = { "7d": 6, "30d": 29, "90d": 89 };
  if (offsets[period]) {
    const dt = new Date(now.getTime());
    dt.setDate(dt.getDate() - offsets[period]);
    return { start: fmt(dt), end: today };
  }
  return { start: "", end: "" };
}
