import { describe, it, expect } from "vitest";
import {
  ASSETS,
  DISPLAY_ORDER,
  isKnownAsset,
  getAssetByIdentifier,
  getAssetKeyById,
  satsToAmount,
  satsToDecimalNumber,
  convertSatsToBrl,
  formatAssetAmount
} from "../wallet/asset-registry.js";

describe("asset-registry metadata", () => {
  it("exposes DePix, USDt and L-BTC with mainnet ids", () => {
    expect(ASSETS.DEPIX.id).toBe(
      "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189"
    );
    expect(ASSETS.USDT.id).toBe(
      "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2"
    );
    expect(ASSETS.LBTC.id).toBe(
      "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d"
    );
  });

  it("DISPLAY_ORDER lists DePix first, then USDt, then L-BTC", () => {
    expect(DISPLAY_ORDER.map(a => a.symbol)).toEqual(["DePix", "USDt", "L-BTC"]);
  });

  it("freezes the asset objects so consumers cannot mutate", () => {
    expect(Object.isFrozen(ASSETS)).toBe(true);
    expect(Object.isFrozen(ASSETS.DEPIX)).toBe(true);
    expect(Object.isFrozen(DISPLAY_ORDER)).toBe(true);
  });
});

describe("isKnownAsset / getAssetByIdentifier", () => {
  it("recognises the three mainnet ids", () => {
    expect(isKnownAsset(ASSETS.DEPIX.id)).toBe(true);
    expect(isKnownAsset(ASSETS.USDT.id)).toBe(true);
    expect(isKnownAsset(ASSETS.LBTC.id)).toBe(true);
  });

  it("rejects unknown or malformed ids", () => {
    expect(isKnownAsset("deadbeef")).toBe(false);
    expect(isKnownAsset("")).toBe(false);
    expect(isKnownAsset(null)).toBe(false);
    expect(isKnownAsset(123)).toBe(false);
  });

  it("getAssetByIdentifier returns the same frozen instance", () => {
    expect(getAssetByIdentifier(ASSETS.DEPIX.id)).toBe(ASSETS.DEPIX);
    expect(getAssetByIdentifier(ASSETS.USDT.id)).toBe(ASSETS.USDT);
    expect(getAssetByIdentifier(ASSETS.LBTC.id)).toBe(ASSETS.LBTC);
    expect(getAssetByIdentifier("nope")).toBe(null);
    expect(getAssetByIdentifier(null)).toBe(null);
  });

  it("getAssetKeyById returns the registry key for known ids", () => {
    expect(getAssetKeyById(ASSETS.DEPIX.id)).toBe("DEPIX");
    expect(getAssetKeyById(ASSETS.USDT.id)).toBe("USDT");
    expect(getAssetKeyById(ASSETS.LBTC.id)).toBe("LBTC");
  });

  it("getAssetKeyById returns null for unknown or invalid input", () => {
    expect(getAssetKeyById("deadbeef")).toBe(null);
    expect(getAssetKeyById("")).toBe(null);
    expect(getAssetKeyById(null)).toBe(null);
    expect(getAssetKeyById(undefined)).toBe(null);
    expect(getAssetKeyById(42)).toBe(null);
  });
});

describe("satsToAmount", () => {
  it("handles the zero and exact boundaries", () => {
    expect(satsToAmount(0n, 8)).toBe("0");
    expect(satsToAmount(100000000n, 8)).toBe("1");
    expect(satsToAmount(1n, 8)).toBe("0.00000001");
  });

  it("trims trailing zeros in the fractional part", () => {
    expect(satsToAmount(150000000n, 8)).toBe("1.5");
    expect(satsToAmount(1234567890n, 8)).toBe("12.3456789");
  });

  it("accepts regular numbers and coerces to BigInt", () => {
    expect(satsToAmount(123, 2)).toBe("1.23");
    expect(satsToAmount(0, 0)).toBe("0");
  });

  it("handles negative amounts with a leading minus", () => {
    expect(satsToAmount(-50000000n, 8)).toBe("-0.5");
  });

  it("throws RangeError for invalid decimals", () => {
    expect(() => satsToAmount(1n, -1)).toThrow(RangeError);
    expect(() => satsToAmount(1n, "x")).toThrow(RangeError);
  });
});

describe("satsToDecimalNumber", () => {
  it("returns a Number representation", () => {
    expect(satsToDecimalNumber(150000000n, 8)).toBe(1.5);
  });
  it("returns 0 when the BigInt-to-number step fails", () => {
    // 0 with any decimals should still be 0
    expect(satsToDecimalNumber(0n, 8)).toBe(0);
  });
});

describe("convertSatsToBrl", () => {
  it("DePix pegs 1:1 to BRL regardless of quote object", () => {
    expect(convertSatsToBrl(100_000_000n, ASSETS.DEPIX, null)).toBe(1);
    expect(convertSatsToBrl(250_000_000n, ASSETS.DEPIX, { btcUsd: 1, usdBrl: 5 })).toBe(2.5);
  });

  it("USDt requires usdBrl", () => {
    expect(convertSatsToBrl(100_000_000n, ASSETS.USDT, null)).toBe(null);
    expect(convertSatsToBrl(100_000_000n, ASSETS.USDT, { btcUsd: 100000, usdBrl: 5.2 })).toBe(5.2);
  });

  it("L-BTC requires btcUsd and usdBrl", () => {
    expect(convertSatsToBrl(100_000_000n, ASSETS.LBTC, { usdBrl: 5.2 })).toBe(null);
    expect(convertSatsToBrl(100_000_000n, ASSETS.LBTC, { btcUsd: 100000, usdBrl: 5 })).toBe(
      500000
    );
  });

  it("returns null for a missing asset", () => {
    expect(convertSatsToBrl(0n, null, {})).toBe(null);
  });
});

describe("formatAssetAmount", () => {
  it("L-BTC shows all 8 decimals trimmed", () => {
    expect(formatAssetAmount(100_000n, ASSETS.LBTC)).toBe("0.001");
    expect(formatAssetAmount(100_000_000n, ASSETS.LBTC)).toBe("1");
  });

  it("DePix preserves full 8-decimal precision", () => {
    // 1.5 DePix — trailing zeros trimmed.
    expect(formatAssetAmount(150_000_000n, ASSETS.DEPIX)).toBe("1.5");
    // 37.231 DePix — precision past 2 decimals survives. Earlier behavior
    // clamped this to "37.23" via toFixed(2), which caused the Max button to
    // undersend by 0.001 DePix (dust) and the preview to lie about the real
    // amount being broadcast.
    expect(formatAssetAmount(3_723_100_000n, ASSETS.DEPIX)).toBe("37.231");
  });

  it("USDt preserves full 8-decimal precision", () => {
    // 0.12345678 USDt — previous behavior rounded to "0.12".
    expect(formatAssetAmount(12_345_678n, ASSETS.USDT)).toBe("0.12345678");
  });

  it("whole amounts render without a decimal point", () => {
    expect(formatAssetAmount(184_500_000_000n, ASSETS.USDT)).toBe("1845");
  });

  it("returns '0' for null asset", () => {
    expect(formatAssetAmount(100n, null)).toBe("0");
  });
});
