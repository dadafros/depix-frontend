// Hardcoded metadata for the assets the wallet surfaces.
//
// Rationale for hardcoding (vs. fetching from a registry):
//   * The three assets we care about (DePix, USDt Liquid, L-BTC) are
//     mainnet-stable — their hex IDs don't change.
//   * Runtime discovery would add a network roundtrip + a third-party trust
//     dependency on every mount. A compromised registry could swap in a lookalike
//     asset and the balance view would display a false value. Hardcoding is
//     simpler and gives us an auditable chain of custody.
//
// Verified IDs per PLANO-FASE-1-WALLET.md Sub-fase 4 "Asset IDs mainnet".
// DePix ID cross-referenced with the Eulen deposit confirmations in production
// traffic; L-BTC and USDt IDs are the well-known Liquid mainnet values.
//
// All amounts throughout LWK are unsigned 8-decimal units ("sats"). The BRL
// conversion helpers accept amounts in those sats and quotes in `{ btcUsd,
// usdBrl }` (floats from the /api/quotes proxy). Because DePix pegs 1:1 to
// BRL by protocol design, its BRL value is simply the display amount.

// Icon URLs are origin-absolute so they resolve consistently whether the
// wallet bundle runs out of /dist/wallet-bundle-<hash>.js or a dev volume
// mount. DePix uses the app icon (icon-192.png IS the DePix brand logo,
// already pre-cached by the service worker). USDt + L-BTC use the
// official Blockstream/Tether artwork vendored from the DePix monorepo's
// BTCPayServer Liquid plugin (submodules/btcpayserver/.../imlegacy/) —
// both are what Blockstream itself ships for these assets.

export const ASSETS = Object.freeze({
  DEPIX: Object.freeze({
    id: "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
    symbol: "DePix",
    name: "DePix",
    decimals: 8,
    color: "#38e3ac",
    brlFormula: "peg",
    iconUrl: "/icon-192.png"
  }),
  USDT: Object.freeze({
    id: "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2",
    symbol: "USDt",
    name: "Tether USD (Liquid)",
    decimals: 8,
    color: "#26a17b",
    brlFormula: "usd",
    iconUrl: "/icons/liquid-tether.svg"
  }),
  LBTC: Object.freeze({
    id: "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d",
    symbol: "L-BTC",
    name: "Liquid Bitcoin",
    decimals: 8,
    color: "#f7931a",
    brlFormula: "btc",
    iconUrl: "/icons/liquid-bitcoin.png"
  })
});

// Display order on the home carteira view. Plan requires DePix first because
// it's the native asset of the app, then USDt, then L-BTC.
export const DISPLAY_ORDER = Object.freeze([
  ASSETS.DEPIX,
  ASSETS.USDT,
  ASSETS.LBTC
]);

export function isKnownAsset(id) {
  if (typeof id !== "string") return false;
  for (const asset of Object.values(ASSETS)) {
    if (asset.id === id) return true;
  }
  return false;
}

export function getAssetByIdentifier(id) {
  if (typeof id !== "string") return null;
  for (const asset of Object.values(ASSETS)) {
    if (asset.id === id) return asset;
  }
  return null;
}

// Convert an integer sats amount to a decimal string, BigInt-safe.
// Trailing zeros are trimmed; whole amounts render without a decimal point.
// e.g. (1234567890n, 8) → "12.3456789"
export function satsToAmount(sats, decimals) {
  if (typeof decimals !== "number" || decimals < 0) {
    throw new RangeError("decimals");
  }
  const n = typeof sats === "bigint" ? sats : BigInt(sats ?? 0);
  if (n < 0n) return "-" + satsToAmount(-n, decimals);
  if (decimals === 0) return n.toString();
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const rem = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return rem.length === 0 ? whole.toString() : `${whole}.${rem}`;
}

// Lossy conversion to JS number — fine for BRL display where we only keep 2
// decimals anyway. Returns 0 if the string is unparseable. Not for balance
// arithmetic; use BigInt for that.
export function satsToDecimalNumber(sats, decimals) {
  const s = satsToAmount(sats, decimals);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

// Convert sats of a given asset to BRL using the quotes object. Returns null
// when the formula is unknown or the needed quote is missing. Callers should
// render a placeholder ("—") rather than a zero when the return is null.
export function convertSatsToBrl(sats, asset, quotes) {
  if (!asset) return null;
  const amount = satsToDecimalNumber(sats, asset.decimals);
  if (asset.brlFormula === "peg") return amount;
  if (!quotes) return null;
  const { btcUsd, usdBrl } = quotes;
  if (asset.brlFormula === "usd") {
    if (!isFiniteNumber(usdBrl)) return null;
    return amount * usdBrl;
  }
  if (asset.brlFormula === "btc") {
    if (!isFiniteNumber(btcUsd) || !isFiniteNumber(usdBrl)) return null;
    return amount * btcUsd * usdBrl;
  }
  return null;
}

// Small helper for the home row: pick the right number of fractional digits
// per asset. Fiat-adjacent (USDt, DePix) shows 2; L-BTC shows 8.
export function formatAssetAmount(sats, asset) {
  if (!asset) return "0";
  const raw = satsToAmount(sats, asset.decimals);
  if (asset.symbol === "L-BTC") return raw;
  // DePix / USDt — clamp to 2 decimals for display.
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(2);
}
