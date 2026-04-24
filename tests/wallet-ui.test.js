// Unit tests for the pure helpers exported from wallet/wallet-ui.js.
//
// DOM-registration (`registerWalletRoutes`) is intentionally NOT covered
// here; its happy path is validated manually per the PR test plan. A jsdom
// integration test (fake wallet module + full router + create/verify/PIN
// happy path + restore BIP39 validation branch) is tracked as follow-up.
// These tests target the pure functions — no DOM dependency, no jsdom
// overhead.

import { describe, it, expect } from "vitest";
import {
  selectChallengeIndices,
  buildChallengeOptions,
  filterBip39Words,
  isPinInputValid,
  classifyLockoutState,
  computeFingerprint,
  parseAmountToSats,
  interpretScannedQr
} from "../wallet/wallet-ui.js";
import { BIP39_WORDLIST } from "../wallet/bip39-wordlist.js";
import { ASSETS } from "../wallet/asset-registry.js";

// Seeded PRNG for determinism. Small LCG — good enough to drive shuffles and
// index picks in tests without pulling a dependency. Never use for crypto.
function makeSeededRandom(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("selectChallengeIndices", () => {
  it("returns exactly n distinct sorted indices in [0, pool)", () => {
    const rand = makeSeededRandom(42);
    const idx = selectChallengeIndices(12, 4, rand);
    expect(idx).toHaveLength(4);
    expect(new Set(idx).size).toBe(4);
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(12);
    }
    const sorted = [...idx].sort((a, b) => a - b);
    expect(idx).toEqual(sorted);
  });

  it("rejects invalid arguments", () => {
    expect(() => selectChallengeIndices(0, 1)).toThrow(RangeError);
    expect(() => selectChallengeIndices(12, -1)).toThrow(RangeError);
    expect(() => selectChallengeIndices(4, 10)).toThrow(RangeError);
  });

  it("selecting all positions covers the full pool", () => {
    const rand = makeSeededRandom(7);
    const idx = selectChallengeIndices(5, 5, rand);
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("buildChallengeOptions", () => {
  it("returns 3 options containing the correct word and two distractors", () => {
    const rand = makeSeededRandom(123);
    const options = buildChallengeOptions("abandon", BIP39_WORDLIST, rand);
    expect(options).toHaveLength(3);
    expect(options).toContain("abandon");
    const distractors = options.filter(o => o !== "abandon");
    expect(distractors).toHaveLength(2);
    for (const d of distractors) {
      expect(BIP39_WORDLIST).toContain(d);
      expect(d).not.toBe("abandon");
    }
  });

  it("never repeats a distractor", () => {
    const rand = makeSeededRandom(5);
    const options = buildChallengeOptions("ability", BIP39_WORDLIST, rand);
    expect(new Set(options).size).toBe(options.length);
  });

  it("throws on invalid arguments", () => {
    expect(() => buildChallengeOptions("", BIP39_WORDLIST)).toThrow(TypeError);
    expect(() => buildChallengeOptions(42, BIP39_WORDLIST)).toThrow(TypeError);
  });
});

describe("filterBip39Words", () => {
  it("returns up to `limit` words starting with the prefix", () => {
    const out = filterBip39Words("ab", BIP39_WORDLIST, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    for (const w of out) {
      expect(w.startsWith("ab")).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    const lower = filterBip39Words("abandon", BIP39_WORDLIST, 10);
    const upper = filterBip39Words("ABANDON", BIP39_WORDLIST, 10);
    expect(lower).toEqual(upper);
  });

  it("returns [] for empty prefix", () => {
    expect(filterBip39Words("", BIP39_WORDLIST)).toEqual([]);
  });

  it("returns [] for non-string input", () => {
    expect(filterBip39Words(null, BIP39_WORDLIST)).toEqual([]);
    expect(filterBip39Words(undefined, BIP39_WORDLIST)).toEqual([]);
  });

  it("finds the exact BIP39 word 'zoo'", () => {
    const out = filterBip39Words("zoo", BIP39_WORDLIST, 1);
    expect(out).toEqual(["zoo"]);
  });
});

describe("isPinInputValid", () => {
  it("accepts a 6-digit numeric string", () => {
    expect(isPinInputValid("123456")).toBe(true);
    expect(isPinInputValid("000000")).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isPinInputValid("12345")).toBe(false);
    expect(isPinInputValid("1234567")).toBe(false);
    expect(isPinInputValid("")).toBe(false);
  });

  it("rejects non-numeric characters", () => {
    expect(isPinInputValid("12345a")).toBe(false);
    expect(isPinInputValid("12 345")).toBe(false);
    expect(isPinInputValid("1234-6")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isPinInputValid(123456)).toBe(false);
    expect(isPinInputValid(null)).toBe(false);
    expect(isPinInputValid(undefined)).toBe(false);
  });
});

describe("classifyLockoutState", () => {
  const now = 1_000_000;

  it("returns 'rate-limited' while the cooldown is active", () => {
    const s = classifyLockoutState({ attempts: 3, rateLimitUntil: now + 10_000, now });
    expect(s).toBe("rate-limited");
  });

  it("returns 'discreet' for low attempt counts", () => {
    expect(classifyLockoutState({ attempts: 0, now })).toBe("discreet");
    expect(classifyLockoutState({ attempts: 1, now })).toBe("discreet");
    expect(classifyLockoutState({ attempts: 2, now })).toBe("discreet");
  });

  it("returns 'warning' with 2 attempts remaining", () => {
    expect(classifyLockoutState({ attempts: 3, now })).toBe("warning");
  });

  it("returns 'final-modal' with 1 attempt remaining", () => {
    expect(classifyLockoutState({ attempts: 4, now })).toBe("final-modal");
  });

  it("returns 'none' once attempts reach/exceed the max", () => {
    expect(classifyLockoutState({ attempts: 5, now })).toBe("none");
    expect(classifyLockoutState({ attempts: 99, now })).toBe("none");
  });

  it("defaults attempts to 0 and gives 'discreet'", () => {
    expect(classifyLockoutState({ now })).toBe("discreet");
  });
});

describe("computeFingerprint", () => {
  it("returns the XXXX-XXXX shape for a non-empty input", async () => {
    const fp = await computeFingerprint("some-descriptor");
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("is deterministic — same input → same fingerprint", async () => {
    const a = await computeFingerprint("ct(slip77(d4),wpkh(xp/*))");
    const b = await computeFingerprint("ct(slip77(d4),wpkh(xp/*))");
    expect(a).toBe(b);
  });

  it("different inputs produce different fingerprints", async () => {
    const a = await computeFingerprint("descriptor-one");
    const b = await computeFingerprint("descriptor-two");
    const c = await computeFingerprint("descriptor-three");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('matches the known SHA-256 prefix for "test" (9F86-D081)', async () => {
    // sha256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b...
    //                  ^^^^^^^^ first 4 bytes
    // With our uppercase + hyphen formatting → 9F86-D081.
    expect(await computeFingerprint("test")).toBe("9F86-D081");
  });

  it("returns '' for empty / null / non-string input", async () => {
    expect(await computeFingerprint("")).toBe("");
    expect(await computeFingerprint(null)).toBe("");
    expect(await computeFingerprint(undefined)).toBe("");
    expect(await computeFingerprint(42)).toBe("");
  });
});

describe("parseAmountToSats", () => {
  it("converts whole numbers with the configured decimals", () => {
    expect(parseAmountToSats("1", 8)).toBe(100_000_000n);
    expect(parseAmountToSats("10", 8)).toBe(1_000_000_000n);
  });

  it("handles fractional amounts with trailing zero padding", () => {
    expect(parseAmountToSats("1.5", 8)).toBe(150_000_000n);
    expect(parseAmountToSats("0.00000001", 8)).toBe(1n);
    expect(parseAmountToSats("12.3", 8)).toBe(1_230_000_000n);
  });

  it("accepts comma as the decimal separator", () => {
    expect(parseAmountToSats("1,5", 8)).toBe(150_000_000n);
    expect(parseAmountToSats("0,25", 2)).toBe(25n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmountToSats("  2.5  ", 8)).toBe(250_000_000n);
  });

  it("rejects non-positive, empty, or malformed inputs", () => {
    expect(() => parseAmountToSats("", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("0", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("0,0", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("abc", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("1.2.3", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("-1", 8)).toThrow(RangeError);
  });

  it("rejects more fractional digits than allowed", () => {
    expect(() => parseAmountToSats("0.000000001", 8)).toThrow(RangeError);
    expect(() => parseAmountToSats("1.234", 2)).toThrow(RangeError);
  });

  it("rejects non-string input and invalid decimals", () => {
    expect(() => parseAmountToSats(1, 8)).toThrow(TypeError);
    expect(() => parseAmountToSats("1", -1)).toThrow(RangeError);
    expect(() => parseAmountToSats("1", "8")).toThrow(RangeError);
  });
});

describe("interpretScannedQr", () => {
  const ADDR = "lq1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5psx4kgu9l78v";

  it("returns address-only fields for a plain Liquid address", () => {
    expect(interpretScannedQr(ADDR, "DEPIX")).toEqual({
      address: ADDR,
      amount: null,
      switchToAssetKey: null,
    });
  });

  it("returns null for an invalid scan payload", () => {
    expect(interpretScannedQr("not a liquid address", "DEPIX")).toBe(null);
    expect(interpretScannedQr("", "DEPIX")).toBe(null);
  });

  it("returns the amount string when a BIP21 URI carries ?amount=", () => {
    const out = interpretScannedQr(`liquid:${ADDR}?amount=0.25`, "DEPIX");
    expect(out).toEqual({ address: ADDR, amount: "0.25", switchToAssetKey: null });
  });

  it("sets switchToAssetKey when the URI's assetid maps to a different known asset", () => {
    const uri = `liquid:${ADDR}?assetid=${ASSETS.USDT.id}`;
    const out = interpretScannedQr(uri, "DEPIX");
    expect(out).toEqual({ address: ADDR, amount: null, switchToAssetKey: "USDT" });
  });

  it("leaves switchToAssetKey null when assetid matches the current asset", () => {
    const uri = `liquid:${ADDR}?assetid=${ASSETS.DEPIX.id}`;
    const out = interpretScannedQr(uri, "DEPIX");
    expect(out.switchToAssetKey).toBe(null);
  });

  it("leaves switchToAssetKey null when assetid is unknown", () => {
    const uri = `liquid:${ADDR}?assetid=${"ab".repeat(32)}`;
    const out = interpretScannedQr(uri, "DEPIX");
    expect(out).toEqual({ address: ADDR, amount: null, switchToAssetKey: null });
  });

  it("combines amount and asset switch in a single BIP21 URI", () => {
    const uri = `liquid:${ADDR}?amount=1.5&assetid=${ASSETS.LBTC.id}`;
    const out = interpretScannedQr(uri, "DEPIX");
    expect(out).toEqual({ address: ADDR, amount: "1.5", switchToAssetKey: "LBTC" });
  });
});
