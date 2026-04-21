import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

import { createWalletModule } from "../wallet/wallet.js";
import { ERROR_CODES } from "../wallet/wallet-errors.js";

// A deterministic fake LWK namespace — same shape as the production module
// exposes, but returns stable values so the integration flow can assert
// descriptor equality byte-for-byte across wipe/restore cycles.
function makeFakeLwk() {
  class Mnemonic {
    constructor(str) {
      const words = String(str).trim().split(/\s+/);
      if (words.length !== 12) throw new Error("fake lwk: 12 words required");
      this._str = words.join(" ");
    }
    toString() { return this._str; }
    static fromRandom() {
      return new Mnemonic(
        "legal winner thank year wave sausage worth useful legal winner thank yellow"
      );
    }
  }
  class Signer {
    constructor(mnemonic) { this._str = mnemonic.toString(); }
    wpkhSlip77Descriptor() { return new WolletDescriptor(`ct(${this._str.replace(/\s+/g, "_")})`); }
    free() {}
  }
  class WolletDescriptor {
    constructor(str) { this._str = str; }
    toString() { return this._str; }
  }
  class AddressResult {
    constructor(s) { this._s = s; }
    address() { return { toString: () => this._s }; }
  }
  class Wollet {
    constructor(_n, d) { this._d = d.toString(); }
    address(i) { return new AddressResult(`lq1-${this._d}-${i ?? 0}`); }
    balance() { return { lbtc: 0 }; }
    transactions() { return []; }
    free() {}
  }
  return {
    Mnemonic, Signer, Wollet, WolletDescriptor,
    Network: {
      mainnet: () => ({ _k: "mainnet" }),
      testnet: () => ({ _k: "testnet" }),
      regtestDefault: () => ({ _k: "regtest" })
    }
  };
}

function newModule({ clock } = {}) {
  const fakeLwk = makeFakeLwk();
  return createWalletModule({
    indexedDbImpl: new IDBFactory(),
    cryptoImpl: webcrypto,
    lwkLoader: async () => fakeLwk,
    clock
  });
}

const PIN = "702486";

describe("end-to-end: create → lock → unlock → wipe → restore", () => {
  it("full happy path plus 5-wrong-PINs wipe and restore", async () => {
    const wallet = newModule();
    const create = await wallet.createWallet({ pin: PIN });
    const originalDescriptor = create.descriptor;
    const originalMnemonic = create.mnemonic;

    // Lock + unlock with right PIN.
    wallet.lock();
    expect(wallet.isUnlocked()).toBe(false);
    const unlocked = await wallet.unlockWithPin(PIN);
    expect(unlocked.descriptor).toBe(originalDescriptor);
    expect(wallet.isUnlocked()).toBe(true);

    // Export returns the original mnemonic.
    expect(await wallet.exportMnemonic(PIN)).toBe(originalMnemonic);

    // Restoring with the same seed should NOT fail and should produce the
    // same descriptor — this is the wipe/restore determinism invariant.
    await wallet.wipeWallet(PIN);
    expect(await wallet.hasWallet()).toBe(false);
    const restore = await wallet.restoreWallet({
      mnemonic: originalMnemonic,
      pin: PIN
    });
    expect(restore.descriptor).toBe(originalDescriptor);

    // View-only surface works immediately.
    const addr = await wallet.getReceiveAddress({ index: 0 });
    expect(addr).toMatch(/^lq1-/);
  }, 180_000);

  it("DESCRIPTOR_MISMATCH when the persisted descriptor differs from the new seed", async () => {
    // Simulate: device was wiped after 5 wrong PINs (which preserves
    // `descriptor`) and the user tries to restore with a different mnemonic.
    // The rate-limit kicks in after the 3rd wrong attempt, so we advance the
    // injected clock between attempts so the test doesn't actually sleep.
    let t = 1_000_000_000_000;
    const clock = () => t;
    const wallet = newModule({ clock });

    await wallet.createWallet({ pin: PIN });
    wallet.lock();
    for (let i = 0; i < 5; i++) {
      try { await wallet.unlockWithPin("358914"); } catch { /* counted */ }
      t += 15_000; // blow past PIN_RATE_LIMIT_MS
    }
    expect(await wallet.hasWallet()).toBe(false); // sensitive fields wiped

    // Restore attempt with a mnemonic that does not match the stored descriptor.
    const different = "legal winner thank year wave sausage worth useful legal winner thank account";
    try {
      await wallet.restoreWallet({ mnemonic: different, pin: PIN });
      throw new Error("expected DESCRIPTOR_MISMATCH");
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.DESCRIPTOR_MISMATCH);
    }
  }, 300_000);
});
